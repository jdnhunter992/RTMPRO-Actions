#!/usr/bin/env python3
"""Publish latest JSON snapshots to one permanent Git branch per publisher.

Each publish replaces the destination branch with an orphan/root commit,
preventing accumulated reachable history. GitHub controls garbage collection
of previously published, now-unreachable objects.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path, PurePosixPath


def git(*args):
    result = subprocess.run(["git", *map(str, args)], text=True, capture_output=True)
    if result.returncode:
        secret = os.environ.get("GH_TOKEN", "")
        error = result.stderr.replace(secret, "[REDACTED]") if secret else result.stderr
        raise RuntimeError(f"Git operation failed: {error.strip()[-1200:]}")
    return result.stdout.strip()


def safe_path(value):
    p = PurePosixPath(value)
    if p.is_absolute() or not value or value in (".", "..") or ".." in p.parts:
        raise ValueError(f"Unsafe data path: {value}")
    return p


def delete_if_exists(path):
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def copy_owned_path(src, dst):
    delete_if_exists(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.copytree(src, dst, symlinks=False)
    else:
        shutil.copy2(src, dst)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["restore", "publish"])
    parser.add_argument("--branch", required=True)
    parser.add_argument("--path", action="append", required=True, dest="paths")
    args = parser.parse_args()

    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", args.branch) or ".." in args.branch:
        raise ValueError("Unsafe branch name")
    paths = [safe_path(p) for p in args.paths]
    for key in ("GH_TOKEN", "GITHUB_REPOSITORY", "GITHUB_WORKSPACE", "RUNNER_TEMP"):
        if not os.environ.get(key):
            raise RuntimeError(f"Missing required environment variable: {key}")
    workspace = Path(os.environ["GITHUB_WORKSPACE"])
    snapshot = Path(os.environ["RUNNER_TEMP"]) / "rtmpro-publisher-snapshot"
    data = workspace / "data"
    branch = args.branch
    remote = f"https://x-access-token:{os.environ['GH_TOKEN']}@github.com/{os.environ['GITHUB_REPOSITORY']}.git"

    if args.operation == "restore":
        if snapshot.exists():
            raise RuntimeError("Publisher snapshot already initialized in this job")
        existing = git("ls-remote", "--heads", remote, f"refs/heads/{branch}")
        if existing:
            git("clone", "--quiet", "--depth", "1", "--single-branch", "--branch", branch, remote, snapshot)
            for rel in paths:
                source = snapshot / rel
                if source.exists():
                    copy_owned_path(source, data / rel)
            print(f"Restored previous {branch} snapshot")
        else:
            snapshot.mkdir(parents=True)
            git("-C", snapshot, "init", "--quiet", "-b", branch)
            git("-C", snapshot, "remote", "add", "origin", remote)
            print(f"First publish for {branch}; branch will be created after validation")
        return

    if not (snapshot / ".git").is_dir():
        raise RuntimeError("Missing snapshot checkout; run restore before publish")
    for rel in paths:
        source = data / rel
        if not source.exists():
            raise RuntimeError(f"Refusing to publish: missing {rel}")
        files = list(source.rglob("*.json")) + list(source.rglob("*.csv")) if source.is_dir() else [source]
        if not files or any(p.stat().st_size == 0 for p in files):
            raise RuntimeError(f"Refusing to publish: empty or missing output under {rel}")
        copy_owned_path(source, snapshot / rel)
    git("-C", snapshot, "add", "--all")
    tree = git("-C", snapshot, "write-tree")
    current = subprocess.run(["git", "-C", str(snapshot), "rev-parse", "--verify", "HEAD"],
                             text=True, capture_output=True)
    previous = current.stdout.strip() if current.returncode == 0 else None
    if previous and tree == git("-C", snapshot, "rev-parse", "HEAD^{tree}"):
        print(f"No changes in {branch}; skipping publish")
        return
    new_sha = git("-C", snapshot, "-c", "user.name=rtmpro-snapshot-bot",
                  "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
                  "commit-tree", tree, "-m", f"Current JSON snapshot ({branch})")
    ref = f"refs/heads/{branch}"
    if previous:
        git("-C", snapshot, "push", f"--force-with-lease={ref}:{previous}", "origin", f"{new_sha}:{ref}")
    else:
        git("-C", snapshot, "push", "origin", f"{new_sha}:{ref}")
    print(f"Published {branch} at {new_sha[:12]} with one reachable root commit")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
