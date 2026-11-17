#!/usr/bin/env python3
"""Download and synchronize publisher-owned prefixes in the shared R2 bucket."""

from __future__ import annotations

import argparse
import base64
import hashlib
import mimetypes
import os
from pathlib import Path, PurePosixPath
import sys

import boto3
from botocore.exceptions import ClientError


def client_and_bucket():
    account = os.environ.get('R2_ACCOUNT_ID', '').strip()
    access_key = os.environ.get('R2_ACCESS_KEY_ID', '').strip()
    secret_key = os.environ.get('R2_SECRET_ACCESS_KEY', '').strip()
    bucket = os.environ.get('R2_BUCKET', '').strip()
    missing = [name for name, value in (
        ('R2_ACCOUNT_ID', account),
        ('R2_ACCESS_KEY_ID', access_key),
        ('R2_SECRET_ACCESS_KEY', secret_key),
        ('vars.R2_BUCKET', bucket),
    ) if not value]
    if missing:
        raise RuntimeError('Missing GitHub Actions R2 configuration: ' + ', '.join(missing))
    endpoint = f'https://{account}.r2.cloudflarestorage.com'
    client = boto3.client(
        's3', endpoint_url=endpoint, region_name='auto',
        aws_access_key_id=access_key, aws_secret_access_key=secret_key,
    )
    return client, bucket


def clean_prefix(value: str) -> str:
    prefix = str(value or '').strip().strip('/')
    parts = PurePosixPath(prefix).parts
    if not prefix or prefix in ('.', '..') or any(part in ('.', '..') for part in parts):
        raise ValueError(f'Unsafe or empty R2 prefix: {value!r}')
    return prefix


def list_keys(client, bucket: str, prefix: str):
    paginator = client.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix.rstrip('/') + '/'):
        for item in page.get('Contents') or []:
            key = item.get('Key')
            if key:
                yield item


def sync_directory(client, bucket: str, source: Path, prefix: str):
    prefix = clean_prefix(prefix)
    if not source.is_dir():
        raise RuntimeError(f'R2 sync source directory does not exist: {source}')
    files = sorted(path for path in source.rglob('*') if path.is_file() and not path.is_symlink())
    if not files:
        raise RuntimeError(f'Refusing to clear R2 prefix from an empty output directory: {source}')

    local_by_key = {}
    for path in files:
        relative = path.relative_to(source).as_posix()
        key = f'{prefix}/{relative}'
        data = path.read_bytes()
        digest = hashlib.md5(data).digest()
        local_by_key[key] = (path, len(data), digest)

    remote_items = list(list_keys(client, bucket, prefix))
    remote_by_key = {item['Key']: item for item in remote_items}
    uploaded = 0
    unchanged = 0
    for key, (path, size, digest) in local_by_key.items():
        current = remote_by_key.get(key)
        remote_etag = str(current.get('ETag') or '').strip('"') if current else ''
        if current and remote_etag.lower() == digest.hex() and int(current.get('Size') or 0) == size:
            unchanged += 1
            continue
        content_type = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        with path.open('rb') as body:
            client.put_object(
                Bucket=bucket,
                Key=key,
                Body=body,
                ContentType=content_type,
                CacheControl='no-cache, max-age=0, must-revalidate',
                ContentMD5=base64.b64encode(digest).decode('ascii'),
            )
        uploaded += 1

    stale = sorted(set(remote_by_key) - set(local_by_key))
    for start in range(0, len(stale), 1000):
        client.delete_objects(Bucket=bucket, Delete={
            'Objects': [{'Key': key} for key in stale[start:start + 1000]],
            'Quiet': True,
        })
    print(f'R2 synchronized {prefix}: uploaded {uploaded}, unchanged {unchanged}, deleted {len(stale)}')


def sync_file(client, bucket: str, source: Path, prefix: str):
    prefix = clean_prefix(prefix)
    if not source.is_file() or source.is_symlink():
        raise RuntimeError(f'R2 sync source file does not exist: {source}')
    data = source.read_bytes()
    md5_hex = hashlib.md5(data).hexdigest()
    try:
        current = client.head_object(Bucket=bucket, Key=prefix)
    except ClientError as error:
        status = error.response.get('ResponseMetadata', {}).get('HTTPStatusCode')
        code = error.response.get('Error', {}).get('Code')
        if status != 404 and code not in ('404', 'NoSuchKey', 'NotFound'):
            raise
        current = None
    if current and str(current.get('ETag') or '').strip('"').lower() == md5_hex and int(current.get('ContentLength') or 0) == len(data):
        print(f'R2 file unchanged: {prefix}')
        return
    client.put_object(
        Bucket=bucket,
        Key=prefix,
        Body=data,
        ContentType=mimetypes.guess_type(source.name)[0] or 'application/octet-stream',
        CacheControl='no-cache, max-age=0, must-revalidate',
        ContentMD5=base64.b64encode(hashlib.md5(data).digest()).decode('ascii'),
    )
    print(f'R2 uploaded file: {prefix}')


def download_prefix(client, bucket: str, prefix: str, destination: Path):
    prefix = clean_prefix(prefix)
    destination.mkdir(parents=True, exist_ok=True)
    count = 0
    for item in list_keys(client, bucket, prefix):
        key = item['Key']
        relative = key[len(prefix.rstrip('/') + '/'):]
        if not relative:
            continue
        output = destination.joinpath(*PurePosixPath(relative).parts)
        output.parent.mkdir(parents=True, exist_ok=True)
        response = client.get_object(Bucket=bucket, Key=key)
        output.write_bytes(response['Body'].read())
        count += 1
    print(f'R2 downloaded {count} objects from {prefix} to {destination}')


def download_key(client, bucket: str, key: str, destination: Path):
    key = clean_prefix(key)
    destination = destination.resolve()
    try:
        response = client.get_object(Bucket=bucket, Key=key)
    except ClientError as error:
        status = error.response.get('ResponseMetadata', {}).get('HTTPStatusCode')
        code = error.response.get('Error', {}).get('Code')
        if status == 404 or code in ('404', 'NoSuchKey', 'NotFound'):
            print(f'R2 key not present yet: {key}')
            return
        raise
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(response['Body'].read())
    print(f'R2 downloaded key {key} to {destination}')


def show_prefix(client, bucket: str, prefix: str):
    prefix = clean_prefix(prefix)
    count = 0
    total_bytes = 0
    for item in list_keys(client, bucket, prefix):
        count += 1
        total_bytes += int(item.get('Size') or 0)
    print(f'R2 prefix {prefix}: {count} objects, {total_bytes} bytes')


def configure_public_read_cors(client, bucket: str):
    client.put_bucket_cors(Bucket=bucket, CORSConfiguration={
        'CORSRules': [{
            'AllowedOrigins': ['*'],
            'AllowedMethods': ['GET', 'HEAD'],
            'ExposeHeaders': ['ETag', 'Content-Length', 'Last-Modified'],
            'MaxAgeSeconds': 86400,
        }],
    })
    print('Configured public read CORS for R2 JSON objects (GET/HEAD).')


def delete_prefix(client, bucket: str, prefix: str):
    prefix = clean_prefix(prefix)
    keys = [item['Key'] for item in list_keys(client, bucket, prefix)]
    for start in range(0, len(keys), 1000):
        client.delete_objects(Bucket=bucket, Delete={
            'Objects': [{'Key': key} for key in keys[start:start + 1000]],
            'Quiet': True,
        })
    print(f'R2 deleted {len(keys)} obsolete objects from {prefix}')


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    download = commands.add_parser('download')
    download.add_argument('--prefix', required=True)
    download.add_argument('--dest', required=True)
    download_one = commands.add_parser('download-key')
    download_one.add_argument('--key', required=True)
    download_one.add_argument('--dest', required=True)
    sync = commands.add_parser('sync')
    sync.add_argument('--root', default='.')
    sync.add_argument('--map', action='append', required=True, metavar='SOURCE=PREFIX')
    delete = commands.add_parser('delete')
    delete.add_argument('--prefix', required=True)
    listing = commands.add_parser('list')
    listing.add_argument('--prefix', required=True)
    commands.add_parser('configure-cors')
    args = parser.parse_args()

    client, bucket = client_and_bucket()
    if args.command == 'download':
        download_prefix(client, bucket, args.prefix, Path(args.dest))
    elif args.command == 'download-key':
        download_key(client, bucket, args.key, Path(args.dest))
    elif args.command == 'delete':
        delete_prefix(client, bucket, args.prefix)
    elif args.command == 'list':
        show_prefix(client, bucket, args.prefix)
    elif args.command == 'configure-cors':
        configure_public_read_cors(client, bucket)
    else:
        root = Path(args.root).resolve()
        for mapping in args.map:
            if '=' not in mapping:
                raise ValueError(f'Invalid mapping {mapping!r}; expected SOURCE=PREFIX')
            source_text, prefix = mapping.split('=', 1)
            source = (root / source_text).resolve()
            if source != root and root not in source.parents:
                raise ValueError(f'R2 source escapes root directory: {source_text!r}')
            if source.is_dir():
                sync_directory(client, bucket, source, prefix)
            else:
                sync_file(client, bucket, source, prefix)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'R2 transfer failed: {error}', file=sys.stderr)
        raise
