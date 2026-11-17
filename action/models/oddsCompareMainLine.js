// Alternate prices at +/-200 or longer should never be treated as the
// projection center's main line when the provider includes them in the feed.
export const MAIN_LINE_MAX_ABSOLUTE_AMERICAN_ODDS = 200;

function impliedProbability(odds) {
  const value = Number(String(odds ?? '').replace(/[^0-9.+-]/g, ''));
  if (!Number.isFinite(value) || value === 0) return null;
  return value > 0 ? 100 / (value + 100) : Math.abs(value) / (Math.abs(value) + 100);
}

/** Relative movement in the no-vig over probability from opening to current odds. */
export function oddsMovementPercent(openingOver, openingUnder, currentOver, currentUnder) {
  const normalizedOverProbability = (overOdds, underOdds) => {
    const overProbability = impliedProbability(overOdds);
    const underProbability = impliedProbability(underOdds);
    if (overProbability != null && underProbability != null) {
      return overProbability / (overProbability + underProbability);
    }
    if (overProbability != null) return overProbability;
    if (underProbability != null) return 1 - underProbability;
    return null;
  };
  const openingProbability = normalizedOverProbability(openingOver, openingUnder);
  const currentProbability = normalizedOverProbability(currentOver, currentUnder);
  return openingProbability == null || openingProbability === 0 || currentProbability == null
    ? null
    : (currentProbability - openingProbability) / openingProbability * 100;
}

function americanOddsDistanceFromEven(entry) {
  const value = Number(String(entry?.odds ?? '').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(value) ? Math.abs(Math.abs(value) - 100) : Number.POSITIVE_INFINITY;
}

/** Pick one sportsbook line, preferring a complete over/under pair priced near even money. */
export function selectMainOddsLine(rows, preferredLine, { requireBothSides = false, maxAbsoluteOdds = Number.POSITIVE_INFINITY } = {}) {
  const candidates = (Array.isArray(rows) ? rows : []).filter((row) => row?.over || row?.under);
  const eligible = candidates.filter((row) => {
    if (requireBothSides && (!row.over || !row.under)) return false;
    if (!requireBothSides && !Number.isFinite(maxAbsoluteOdds)) return true;
    return [row.over, row.under].filter(Boolean).every((entry) => {
      const odds = Number(String(entry?.odds ?? '').replace(/[^0-9.+-]/g, ''));
      return Number.isFinite(odds) && odds !== 0 && Math.abs(odds) < maxAbsoluteOdds;
    });
  });
  if (!eligible.length) return null;
  const preferred = Number(preferredLine);
  return [...eligible].sort((a, b) => {
    const aSides = Number(Boolean(a.over)) + Number(Boolean(a.under));
    const bSides = Number(Boolean(b.over)) + Number(Boolean(b.under));
    if (aSides !== bSides) return bSides - aSides;

    const aEvenScore = americanOddsDistanceFromEven(a.over) + americanOddsDistanceFromEven(a.under);
    const bEvenScore = americanOddsDistanceFromEven(b.over) + americanOddsDistanceFromEven(b.under);
    if (aEvenScore !== bEvenScore) return aEvenScore - bEvenScore;

    const aLine = Number(a.line);
    const bLine = Number(b.line);
    const aPreferredDistance = Number.isFinite(preferred) && Number.isFinite(aLine) ? Math.abs(aLine - preferred) : Number.POSITIVE_INFINITY;
    const bPreferredDistance = Number.isFinite(preferred) && Number.isFinite(bLine) ? Math.abs(bLine - preferred) : Number.POSITIVE_INFINITY;
    if (aPreferredDistance !== bPreferredDistance) return aPreferredDistance - bPreferredDistance;
    return (Number.isFinite(aLine) ? aLine : Number.POSITIVE_INFINITY) - (Number.isFinite(bLine) ? bLine : Number.POSITIVE_INFINITY);
  })[0];
}

/** Build one paired, near-even main line per sportsbook from a prop's full odds feed. */
export function buildSportsbookMainLineRows(prop, options = {}) {
  const entries = (Array.isArray(prop?.allOdds) && prop.allOdds.length
    ? prop.allOdds
    : Array.isArray(prop?.selectedLineOdds) ? prop.selectedLineOdds : [])
    .filter((entry) => entry?.odds != null && ['over', 'under'].includes(String(entry.side || '').toLowerCase()));
  const books = new Map();

  entries.forEach((entry) => {
    const rawBook = String(entry.bookKey || entry.book || 'sportsbook');
    const normalizedBook = rawBook.toLowerCase().replace(/[^a-z0-9]/g, '');
    const bookKey = normalizedBook === 'riverscasino' ? 'betrivers' : normalizedBook;
    const side = String(entry.side).toLowerCase();
    const numericLine = Number(entry.line ?? prop?.line);
    if (!Number.isFinite(numericLine)) return;
    const lineKey = String(numericLine);
    if (!books.has(bookKey)) books.set(bookKey, new Map());
    const lines = books.get(bookKey);
    if (!lines.has(lineKey)) {
      lines.set(lineKey, {
        book: entry.book || entry.bookKey || 'Sportsbook',
        bookKey,
        logo: entry.bookLogo || entry.logo || null,
        line: numericLine,
        over: null,
        under: null,
      });
    }
    const row = lines.get(lineKey);
    const existing = row[side];
    if (!existing || americanOddsDistanceFromEven(entry) < americanOddsDistanceFromEven(existing)) {
      row[side] = entry;
    }
  });

  return [...books.values()].flatMap((lines) => {
    const main = selectMainOddsLine([...lines.values()], prop?.line, options);
    return main ? [main] : [];
  });
}

/** Select each book's opening main line independently from its opening prices. */
export function buildSportsbookOpeningLineRows(prop, { maxAbsoluteOdds = MAIN_LINE_MAX_ABSOLUTE_AMERICAN_ODDS } = {}) {
  const entries = (Array.isArray(prop?.allOdds) && prop.allOdds.length
    ? prop.allOdds
    : Array.isArray(prop?.selectedLineOdds) ? prop.selectedLineOdds : [])
    .filter((entry) => ['over', 'under'].includes(String(entry?.side || '').toLowerCase())
      && entry?.opening_line != null && entry.opening_line !== ''
      && entry?.opening_price != null && entry.opening_price !== '');
  const books = new Map();

  entries.forEach((entry) => {
    const rawBook = String(entry.bookKey || entry.book || 'sportsbook');
    const normalizedBook = rawBook.toLowerCase().replace(/[^a-z0-9]/g, '');
    const bookKey = normalizedBook === 'riverscasino' ? 'betrivers' : normalizedBook;
    const side = String(entry.side).toLowerCase();
    const line = Number(entry.opening_line);
    const odds = Number(entry.opening_price);
    if (!Number.isFinite(line) || !Number.isFinite(odds)) return;
    if (!books.has(bookKey)) books.set(bookKey, new Map());
    const lines = books.get(bookKey);
    const lineKey = String(line);
    if (!lines.has(lineKey)) {
      lines.set(lineKey, {
        book: entry.book || entry.bookKey || 'Sportsbook',
        bookKey,
        logo: entry.bookLogo || entry.logo || null,
        line,
        over: null,
        under: null,
      });
    }
    const row = lines.get(lineKey);
    const openingEntry = { ...entry, line, odds };
    const existing = row[side];
    if (!existing || americanOddsDistanceFromEven(openingEntry) < americanOddsDistanceFromEven(existing)) {
      row[side] = openingEntry;
    }
  });

  return [...books.values()].flatMap((lines) => {
    const openingMain = selectMainOddsLine([...lines.values()], prop?.line, {
      requireBothSides: true,
      maxAbsoluteOdds,
    });
    return openingMain ? [openingMain] : [];
  });
}
