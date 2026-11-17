import { buildSportsbookMainLineRows, buildSportsbookOpeningLineRows, MAIN_LINE_MAX_ABSOLUTE_AMERICAN_ODDS, selectMainOddsLine } from './oddsCompareMainLine.js';

const MARKET_ALIASES = {
  passing_yards: 'passing_yards',
  passing_attempts: 'passing_attempts',
  pass_attempts: 'passing_attempts',
  rushing_yards: 'rushing_yards',
  rushing_attempts: 'rushing_attempts',
  rush_attempts: 'rushing_attempts',
  receiving_yards: 'receiving_yards',
  receptions: 'receptions',
};

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function number(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(String(value).replace(/,/g, '').replace(/%/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function average(values, fallback = null) {
  const usable = values.filter((value) => Number.isFinite(value));
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : fallback;
}

function weightedRecent(player, field, fallback = 0) {
  const season = number(player?.[field], player?.seasonStats?.[field]);
  const l5 = number(player?._l5?.[field], player?.l5Stats?.[field]);
  const l10 = number(player?._l10?.[field], player?.l10Stats?.[field]);
  const values = [l5, l10, season].filter((value) => Number.isFinite(value));
  if (!values.length) return fallback;
  if (Number.isFinite(l5) && Number.isFinite(l10) && Number.isFinite(season)) {
    return 0.5 * l5 + 0.3 * l10 + 0.2 * season;
  }
  return average(values, fallback);
}

function workloadLine(context, names) {
  return number(...names.flatMap((name) => [context?.[name], context?.vegas?.[name], context?.lines?.[name]]));
}

function roleScore(player, market, context = {}) {
  const position = String(player?.position || '').toUpperCase();
  const depth = number(player?.depthRank, player?.depth_rank, player?.depth);
  const snaps = number(player?.snapShare, player?.snap_share, player?.snapPct);
  const attempts = weightedRecent(player, 'attempts');
  const carries = weightedRecent(player, 'carries');
  const targets = weightedRecent(player, 'targets');

  if (market === 'passing_yards' || market === 'passing_attempts') {
    if (position === 'QB' && context.marketOddsAvailable) return 0.98;
    return position === 'QB' ? clamp(
      0.55 * (depth === 1 ? 1 : 0) + 0.45 * clamp(attempts / 32, 0, 1), 0, 1,
    ) : 0;
  }
  if (market === 'rushing_yards' || market === 'rushing_attempts') {
    if (position === 'QB') return clamp(0.5 * (depth === 1 ? 1 : 0) + 0.5 * clamp(attempts / 28, 0, 1), 0, 1);
    if (position !== 'RB') return 0;
    return clamp(0.4 * (depth && depth <= 2 ? 1 : 0) + 0.35 * clamp(carries / 15, 0, 1) + 0.25 * clamp((snaps ?? 0) / 0.7, 0, 1), 0, 1);
  }
  if (!['RB', 'FB', 'WR', 'TE'].includes(position)) return 0;
  return clamp(0.4 * (depth && depth <= 2 ? 1 : 0) + 0.35 * clamp(targets / 8, 0, 1) + 0.25 * clamp((snaps ?? 0) / 0.75, 0, 1), 0, 1);
}

function environmentMultiplier(context = {}, market) {
  const spread = number(context.teamSpread, context.team_spread, context.spread) ?? 0;
  const total = number(context.total, context.totalLine, context.total_line) ?? 44;
  const wind = number(context.wind, context.windSpeed, context.weatherWind) ?? 0;
  const precipitation = number(context.precipitation, context.rain, context.weatherPrecipitation) ?? 0;
  const isPassing = market === 'passing_yards' || market === 'passing_attempts';
  const isRushing = market === 'rushing_yards' || market === 'rushing_attempts';
  const spreadValue = number(context.teamSpread, context.team_spread, context.spread);
  let multiplier = 1;

  if (Number.isFinite(total)) multiplier += (total - 44) * 0.004;
  if (Number.isFinite(spreadValue)) {
    const favoriteScript = Math.min(Math.abs(Math.min(spreadValue, 0)) * 0.012, 0.12);
    const underdogScript = Math.min(Math.max(spreadValue, 0) * 0.012, 0.12);
    if (isRushing) multiplier += spreadValue < 0 ? favoriteScript : -underdogScript;
    if (isPassing) multiplier += spreadValue < 0 ? -favoriteScript * 0.65 : underdogScript;
  }
  if (market === 'receiving_yards' || market === 'receptions') multiplier += (total - 44) * 0.003;
  if (wind >= 15) multiplier += isRushing ? 0.025 : -0.04;
  if (precipitation > 0) multiplier += isRushing ? 0.02 : -0.025;
  return clamp(multiplier, 0.82, 1.18);
}

function matchupMultiplier(context = {}, market) {
  const value = number(
    context.matchupMultiplier,
    context.opponentMultiplier,
    context.opponent?.[market],
  );
  return clamp(value ?? 1, 0.85, 1.15);
}

function americanImpliedProbability(value) {
  const odds = number(value);
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Use FanDuel as the shared model market input, with a book-independent median fallback. */
export function buildNFLProjectionMarketInput(mainRows = []) {
  const rows = (Array.isArray(mainRows) ? mainRows : []).filter((row) =>
    row?.line != null && String(row.line).trim() !== '' && Number.isFinite(Number(row.line))
    && row?.over?.odds != null && row?.under?.odds != null,
  );
  const isFanDuel = (row) => [row?.bookKey, row?.book].some((value) => {
    const key = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return key.startsWith('fanduel');
  });
  const fanDuelRow = rows.find(isFanDuel);
  if (fanDuelRow) {
    return {
      source: 'FanDuel',
      line: Number(fanDuelRow.line),
      overOdds: fanDuelRow.over.odds,
      underOdds: fanDuelRow.under.odds,
      marketOddsAvailable: true,
    };
  }

  const medianLine = median(rows.map((row) => Number(row.line)));
  if (medianLine == null) return { source: 'Player stats', line: null, marketOddsAvailable: false };
  const distances = rows.map((row) => Math.abs(Number(row.line) - medianLine));
  const closestDistance = Math.min(...distances);
  const closestRows = rows.filter((row) => Math.abs(Math.abs(Number(row.line) - medianLine) - closestDistance) < 1e-9);
  const overProbabilities = closestRows.map((row) => {
    const over = americanImpliedProbability(row.over.odds);
    const under = americanImpliedProbability(row.under.odds);
    return over != null && under != null ? over / (over + under) : null;
  }).filter(Number.isFinite);

  return {
    source: 'Median line',
    line: medianLine,
    marketOverProbability: median(overProbabilities),
    marketOddsAvailable: overProbabilities.length > 0,
  };
}

function marketCalibratedProjection(rawProjection, context = {}) {
  const marketInput = context.marketInput || {};
  const line = number(marketInput.line, context.line, context.propLine, context.sportsbookLine, context.vegas?.line);
  if (!Number.isFinite(line)) return { projected: rawProjection, marketWeight: 0, marketOverProbability: null };

  const overProbability = americanImpliedProbability(marketInput.overOdds ?? context.overOdds ?? context.over_american ?? context.currentOverOdds);
  const underProbability = americanImpliedProbability(marketInput.underOdds ?? context.underOdds ?? context.under_american ?? context.currentUnderOdds);
  const probabilityTotal = (overProbability ?? 0) + (underProbability ?? 0);
  const marketOverProbability = Number.isFinite(marketInput.marketOverProbability)
    ? marketInput.marketOverProbability
    : probabilityTotal > 0 ? (overProbability ?? 0) / probabilityTotal : 0.5;
  const hasOdds = marketInput.marketOddsAvailable
    || (Number.isFinite(overProbability) && Number.isFinite(underProbability));
  const marketBias = marketOverProbability - 0.5;
  const marketPrior = Math.max(0, line * (1 + marketBias * 0.12));
  const lineGap = Math.abs(line - rawProjection) / Math.max(Math.abs(rawProjection), 1);
  const roleChangeWeight = Math.min(0.4, Math.max(0, (lineGap - 0.15) * 1.2));
  const marketWeight = Math.min(0.75, (hasOdds ? 0.35 : 0.25) + roleChangeWeight);

  return {
    projected: rawProjection * (1 - marketWeight) + marketPrior * marketWeight,
    marketWeight,
    marketOverProbability,
    lineGap,
    roleChangeWeight,
  };
}

function getProjection(player, market, context) {
  const attempts = weightedRecent(player, 'attempts');
  const carries = weightedRecent(player, 'carries');
  const targets = weightedRecent(player, 'targets');
  const receptions = weightedRecent(player, 'receptions');
  const passingYards = weightedRecent(player, 'passingYards');
  const rushingYards = weightedRecent(player, 'rushingYards');
  const receivingYards = weightedRecent(player, 'receivingYards');
  const passLine = workloadLine(context, ['passingAttempts', 'passAttempts', 'attempts']);
  const rushLine = workloadLine(context, ['rushingAttempts', 'rushAttempts', 'carries']);
  const receptionLine = workloadLine(context, ['receptions', 'reception']);
  const targetLine = workloadLine(context, ['targets', 'target']);
  const env = environmentMultiplier(context, market);
  const matchup = matchupMultiplier(context, market);
  let base;
  let workload;

  if (market === 'passing_yards') {
    workload = passLine ?? attempts;
    const efficiency = attempts > 0 ? passingYards / attempts : number(player?.yardsPerAttempt, player?.YPA) ?? 7;
    base = workload * clamp(efficiency, 4.5, 10.5);
  } else if (market === 'passing_attempts') {
    workload = passLine ?? attempts;
    base = workload;
  } else if (market === 'rushing_yards') {
    workload = rushLine ?? carries;
    const efficiency = carries > 0 ? rushingYards / carries : number(player?.yardsPerCarry, player?.YPC) ?? 4.2;
    base = workload * clamp(efficiency, 2.5, 6.5);
  } else if (market === 'rushing_attempts') {
    workload = rushLine ?? carries;
    base = workload;
  } else if (market === 'receiving_yards') {
    const catchRate = targets > 0 ? receptions / targets : 0.65;
    const yardsPerReception = receptions > 0 ? receivingYards / receptions : number(player?.yardsPerReception, player?.YPR) ?? 10.5;
    const lineReceptions = receptionLine ?? (targetLine != null ? targetLine * catchRate : null);
    workload = lineReceptions ?? receptions;
    base = workload * clamp(yardsPerReception, 5, 18);
  } else if (market === 'receptions') {
    const catchRate = targets > 0 ? receptions / targets : 0.65;
    workload = receptionLine ?? (targetLine != null ? targetLine * catchRate : receptions);
    base = workload;
  } else {
    throw new Error(`Unsupported NFL projection market: ${market}`);
  }

  const projected = Math.max(0, base * env);
  return { projected, workload, base, environmentMultiplier: env, matchupMultiplier: matchup };
}

export function projectNFLPlayerPerformance({ player = {}, market, context = {} } = {}) {
  const canonicalMarket = MARKET_ALIASES[String(market || '').toLowerCase()];
  if (!canonicalMarket) throw new Error(`Unsupported NFL projection market: ${market}`);
  const role = roleScore(player, canonicalMarket, context);
  const calculation = getProjection(player, canonicalMarket, context);
  const marketCalibration = marketCalibratedProjection(calculation.projected, context);
  const projected = Math.max(0, marketCalibration.projected * calculation.matchupMultiplier);
  const line = number(context.line, context.propLine, context.sportsbookLine, context.vegas?.line);
  const uncertainty = canonicalMarket.includes('attempts') || canonicalMarket === 'receptions' ? 0.22 : 0.32;
  const interval = Math.max(1, projected * uncertainty);

  return {
    player: player.name || player.playerName || player.player_display_name || null,
    market: canonicalMarket,
    projection: Number(projected.toFixed(2)),
    lower: Number(Math.max(0, projected - interval).toFixed(2)),
    upper: Number((projected + interval).toFixed(2)),
    roleScore: Number(role.toFixed(3)),
    primaryPlayer: role >= 0.45,
    workloadUsed: calculation.workload == null ? null : Number(calculation.workload.toFixed(2)),
    line: line == null ? null : line,
    edge: line == null ? null : Number((projected - line).toFixed(2)),
    components: {
      volumeProjection: calculation.workload == null ? null : Number(calculation.workload.toFixed(2)),
      unadjustedProjection: Number(calculation.base.toFixed(2)),
      environmentMultiplier: Number(calculation.environmentMultiplier.toFixed(3)),
      matchupMultiplier: Number(calculation.matchupMultiplier.toFixed(3)),
      marketWeight: Number(marketCalibration.marketWeight.toFixed(3)),
      marketOverProbability: marketCalibration.marketOverProbability == null ? null : Number(marketCalibration.marketOverProbability.toFixed(4)),
      lineGap: Number((marketCalibration.lineGap || 0).toFixed(3)),
      roleChangeWeight: Number((marketCalibration.roleChangeWeight || 0).toFixed(3)),
    },
  };
}

export function projectNFLPlayerMarkets({ player, markets, context = {} } = {}) {
  const requested = Array.isArray(markets) && markets.length
    ? markets
    : ['passing_yards', 'passing_attempts', 'rushing_yards', 'rushing_attempts', 'receiving_yards', 'receptions'];
  return requested.map((market) => projectNFLPlayerPerformance({ player, market, context }));
}

function seededRandom(seed) {
  let state = Math.abs(Number(seed)) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function normalRandom(random) {
  const first = Math.max(random(), Number.EPSILON);
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function percentile(sortedValues, percentile) {
  if (!sortedValues.length) return null;
  const index = (sortedValues.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

function projectionTeamCode(value) {
  const raw = String(value || "").toUpperCase().replace(/[^A-Z]/g, "");
  const aliases = { GNB: "GB", KAN: "KC", NWE: "NE", NOR: "NO", SFO: "SF", TAM: "TB", LVR: "LV", JAC: "JAX", WAS: "WSH", WFT: "WSH", OAK: "LV", SD: "LAC", LA: "LAR" };
  return aliases[raw] || raw;
}

function projectionPosition(player) {
  const value = String(player?.position || player?.Position || "").toUpperCase();
  return ["QB", "RB", "WR", "TE"].find((position) => value.includes(position)) || "";
}

export function getNFLProjectionGameContext(games, playerTeam, opponentTeam) {
  const team = projectionTeamCode(playerTeam);
  const opponent = projectionTeamCode(opponentTeam);
  const game = (games || []).find((event) => {
    const competitors = event?.competitions?.[0]?.competitors || [];
    const teams = competitors.map((competitor) => projectionTeamCode(competitor?.team?.abbreviation || competitor?.team?.shortDisplayName));
    return teams.includes(team) && (!opponent || teams.includes(opponent));
  });
  const odds = game?.competitions?.[0]?.odds?.[0] || {};
  const competitors = game?.competitions?.[0]?.competitors || [];
  const away = competitors.find((competitor) => competitor?.homeAway === 'away') || competitors[1];
  const home = competitors.find((competitor) => competitor?.homeAway === 'home') || competitors[0];
  const awayTeam = projectionTeamCode(away?.team?.abbreviation || away?.team?.shortDisplayName);
  const homeTeam = projectionTeamCode(home?.team?.abbreviation || home?.team?.shortDisplayName);
  const awayOdds = odds.awayTeamOdds || odds.away_team_odds || {};
  const homeOdds = odds.homeTeamOdds || odds.home_team_odds || {};
  const numeric = (value) => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const awaySpread = numeric(awayOdds.spread ?? awayOdds.pointSpread);
  const homeSpread = numeric(homeOdds.spread ?? homeOdds.pointSpread);
  const genericSpread = numeric(odds.spread ?? odds.pointSpread);
  const awayMoneyline = numeric(awayOdds.moneyLine ?? awayOdds.moneyline ?? awayOdds.money_line);
  const homeMoneyline = numeric(homeOdds.moneyLine ?? homeOdds.moneyline ?? homeOdds.money_line);

  // ESPN's team spread fields are occasionally unsigned or duplicated. Resolve
  // which team is favored independently, then apply a consistent negative line
  // to that team and positive line to the underdog.
  let favorite = null;
  if (awayOdds.favorite === true || awayOdds.isFavorite === true) favorite = awayTeam;
  else if (homeOdds.favorite === true || homeOdds.isFavorite === true) favorite = homeTeam;
  else if (awayOdds.underdog === true && homeOdds.underdog !== true) favorite = homeTeam;
  else if (homeOdds.underdog === true && awayOdds.underdog !== true) favorite = awayTeam;

  if (!favorite && awaySpread != null && homeSpread != null && Math.sign(awaySpread) !== Math.sign(homeSpread)) {
    favorite = awaySpread < homeSpread ? awayTeam : homeTeam;
  }

  const details = String(odds.details || '').toUpperCase();
  if (!favorite && details) {
    const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const spreadMatch = details.match(/[+-]\s*\d+(?:\.\d+)?/);
    if (spreadMatch) {
      const detailLine = Number(spreadMatch[0].replace(/\s/g, ''));
      const mentionsAway = awayTeam && new RegExp(`(?:^|[^A-Z])${escapeRegex(awayTeam)}(?:$|[^A-Z])`).test(details);
      const mentionsHome = homeTeam && new RegExp(`(?:^|[^A-Z])${escapeRegex(homeTeam)}(?:$|[^A-Z])`).test(details);
      if (detailLine < 0 && mentionsAway) favorite = awayTeam;
      else if (detailLine < 0 && mentionsHome) favorite = homeTeam;
      else if (detailLine > 0 && mentionsAway) favorite = homeTeam;
      else if (detailLine > 0 && mentionsHome) favorite = awayTeam;
    }
  }

  if (!favorite && awayMoneyline != null && homeMoneyline != null) {
    const implied = (line) => line < 0 ? Math.abs(line) / (Math.abs(line) + 100) : 100 / (line + 100);
    const awayImplied = implied(awayMoneyline);
    const homeImplied = implied(homeMoneyline);
    if (awayImplied !== homeImplied) favorite = awayImplied > homeImplied ? awayTeam : homeTeam;
  }

  const selectedSideSpread = team === awayTeam ? awaySpread : team === homeTeam ? homeSpread : null;
  const spreadMagnitude = Math.max(...[awaySpread, homeSpread, genericSpread].filter((value) => value != null).map(Math.abs));
  let spread = null;
  if (Number.isFinite(spreadMagnitude)) {
    if (favorite) spread = team === favorite ? -spreadMagnitude : team === awayTeam || team === homeTeam ? spreadMagnitude : null;
    else if (selectedSideSpread != null) spread = selectedSideSpread;
  }
  const total = Number(odds.overUnder ?? odds.total ?? odds.over_under);
  return {
    spread: Number.isFinite(spread) ? spread : null,
    total: Number.isFinite(total) ? total : null,
  };
}

const PROJECTION_MARKET_FALLBACKS = {
  QB: { passing_yards: 225.5, passing_attempts: 32.5, rushing_yards: 20.5, rushing_attempts: 4.5 },
  RB: { rushing_yards: 65.5, rushing_attempts: 14.5, receiving_yards: 20.5, receptions: 2.5 },
  WR: { receiving_yards: 55.5, receptions: 4.5, rushing_yards: 8.5 },
  TE: { receiving_yards: 45.5, receptions: 3.5 },
};

export function getNFLProjectionMarketFallback(player, market) {
  const position = projectionPosition(player);
  return PROJECTION_MARKET_FALLBACKS[position]?.[String(market || '').toLowerCase()] ?? null;
}

export function buildNFLProjectionOpponentDefenseMap(rows = []) {
  const fields = {
    passing_yards: "passingYards",
    passing_attempts: "attempts",
    rushing_yards: "rushingYards",
    rushing_attempts: "carries",
    receiving_yards: "receivingYards",
    receptions: "receptions",
  };
  const buckets = new Map();
  const seasons = rows.flatMap((row) => (Array.isArray(row?.weeklyLogs) ? row.weeklyLogs : row?._allRows || []).map((log) => Number(log?.season))).filter(Number.isFinite);
  const latestSeason = seasons.length ? Math.max(...seasons) : null;
  const addValue = (opponent, position, market, value, gameKey) => {
    if (!opponent || !Number.isFinite(value)) return;
    const key = `${position}:${market}`;
    if (!buckets.has(opponent)) buckets.set(opponent, new Map());
    const teamBuckets = buckets.get(opponent);
    if (!teamBuckets.has(key)) teamBuckets.set(key, { total: 0, games: new Set() });
    const bucket = teamBuckets.get(key);
    bucket.total += value;
    bucket.games.add(gameKey);
  };
  rows.forEach((row) => {
    const position = projectionPosition(row);
    if (!position) return;
    const logs = Array.isArray(row?.weeklyLogs) ? row.weeklyLogs : row?._allRows || [];
    logs.forEach((log) => {
      if (latestSeason != null && Number(log?.season) !== latestSeason) return;
      const opponent = projectionTeamCode(log?.opponent || log?.opponent_team || log?.opp);
      const gameKey = `${log?.season || ""}-${log?.week || ""}-${log?.gameDate || log?.game_date || log?.date || ""}`;
      Object.entries(fields).forEach(([market, field]) => {
        const value = Number(log?.[field] ?? log?.[field.replace(/([A-Z])/g, "_$1").toLowerCase()]);
        addValue(opponent, position, market, value, gameKey);
      });
    });
  });
  const leagueAverages = new Map();
  buckets.forEach((teamBuckets) => teamBuckets.forEach((bucket, key) => {
    const averageAllowed = bucket.games.size ? bucket.total / bucket.games.size : null;
    if (averageAllowed == null) return;
    leagueAverages.set(key, [...(leagueAverages.get(key) || []), averageAllowed]);
  }));
  const defenseMap = new Map();
  buckets.forEach((teamBuckets, opponent) => {
    const markets = {};
    teamBuckets.forEach((bucket, key) => {
      const averageAllowed = bucket.games.size ? bucket.total / bucket.games.size : null;
      const leagueValues = leagueAverages.get(key) || [];
      const leagueAverage = leagueValues.length ? leagueValues.reduce((sum, value) => sum + value, 0) / leagueValues.length : null;
      if (averageAllowed == null || !Number.isFinite(leagueAverage) || leagueAverage <= 0) return;
      const sampleWeight = bucket.games.size / (bucket.games.size + 8);
      const stabilizedAverage = leagueAverage + (averageAllowed - leagueAverage) * sampleWeight;
      markets[key] = { averageAllowed, leagueAverage, sampleSize: bucket.games.size, sampleWeight, matchupMultiplier: Math.min(1.15, Math.max(0.85, stabilizedAverage / leagueAverage)) };
    });
    defenseMap.set(opponent, markets);
  });
  return defenseMap;
}

export function buildNFLProjectionSimulation({ player = {}, market, line, overOdds, underOdds, marketOddsAvailable = false, marketInput = null, spread = null, total = null, opponentDefense = null } = {}) {
  const logs = (Array.isArray(player?.weeklyLogs) ? player.weeklyLogs : player?._allRows || []).slice(-10);
  const fields = ["attempts", "carries", "targets", "receptions", "passingYards", "rushingYards", "receivingYards"];
  const averageField = (rows, field) => {
    const values = rows.map((row) => Number(row?.[field] ?? row?.[field.replace(/([A-Z])/g, "_$1").toLowerCase()])).filter(Number.isFinite);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const modelPlayer = {
    ...player,
    _l5: Object.fromEntries(fields.map((field) => [field, averageField(logs.slice(-5), field)])),
    _l10: Object.fromEntries(fields.map((field) => [field, averageField(logs, field)])),
    seasonStats: Object.fromEntries(fields.map((field) => [field, averageField(logs, field)])),
  };
  return simulateNFLPlayerProjection({
    player: modelPlayer,
    market,
    context: {
      line,
      overOdds,
      underOdds,
      marketOddsAvailable,
      marketInput,
      spread,
      total,
      matchupMultiplier: opponentDefense?.matchupMultiplier,
      opponentDefense,
    },
    seed: `${player?.name || player?.Player}:${market}`.split("").reduce((sum, character) => sum + character.charCodeAt(0), 17),
  });
}

export function buildNFLProjectionMarketInputs(prop = {}) {
  const marketKey = String(prop?.market || prop?.marketKey || prop?.market_key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizedMarket = MARKET_ALIASES[marketKey] || marketKey;
  const mainRows = buildSportsbookMainLineRows(prop, { requireBothSides: true, maxAbsoluteOdds: MAIN_LINE_MAX_ABSOLUTE_AMERICAN_ODDS })
    .filter((row) => normalizedMarket !== 'receptions' || Number(row.line) <= 20);
  const openingRows = buildSportsbookOpeningLineRows(prop, { maxAbsoluteOdds: MAIN_LINE_MAX_ABSOLUTE_AMERICAN_ODDS })
    .filter((row) => normalizedMarket !== 'receptions' || Number(row.line) <= 20);
  const bestRow = selectMainOddsLine(mainRows, prop?.line, { requireBothSides: true, maxAbsoluteOdds: MAIN_LINE_MAX_ABSOLUTE_AMERICAN_ODDS });
  const bestOpeningRow = selectMainOddsLine(openingRows, prop?.line, { requireBothSides: true, maxAbsoluteOdds: MAIN_LINE_MAX_ABSOLUTE_AMERICAN_ODDS });
  const line = bestRow && Number.isFinite(Number(bestRow.line)) ? Number(bestRow.line) : null;
  return {
    line,
    overOdds: bestRow?.over?.odds ?? null,
    underOdds: bestRow?.under?.odds ?? null,
    marketOddsAvailable: Boolean(bestRow),
    bestRow,
    bestOpeningRow,
    mainRows,
    openingRows,
  };
}

export function simulateNFLPlayerProjection({
  player,
  market,
  context = {},
  simulations = 10000,
  seed = 20260923,
} = {}) {
  const projection = projectNFLPlayerPerformance({ player, market, context });
  const count = Math.max(1000, Math.min(50000, Math.floor(Number(simulations) || 10000)));
  const random = seededRandom(seed);
  const standardDeviation = Math.max(0.75, projection.projection * (projection.market === 'receptions' || projection.market.includes('attempts') ? 0.18 : 0.28));
  const samples = Array.from({ length: count }, () => Math.max(0, projection.projection + normalRandom(random) * standardDeviation)).sort((a, b) => a - b);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const line = projection.line;
  const overCount = Number.isFinite(line) ? samples.filter((value) => value > line).length : null;
  const minimum = samples[0];
  const maximum = samples[samples.length - 1];
  const binCount = 30;
  const binWidth = Math.max(1, (maximum - minimum) / binCount);
  const distribution = Array.from({ length: binCount }, (_, index) => {
    const start = minimum + index * binWidth;
    const end = index === binCount - 1 ? maximum + Number.EPSILON : start + binWidth;
    const binCountValues = samples.filter((value) => value >= start && value < end).length;
    return {
      value: Number((start + (end - start) / 2).toFixed(2)),
      low: Number(start.toFixed(2)),
      high: Number(end.toFixed(2)),
      probability: Number((binCountValues / samples.length).toFixed(4)),
    };
  });

  return {
    ...projection,
    simulations: count,
    mean: Number(mean.toFixed(2)),
    p5: Number(percentile(samples, 0.05).toFixed(2)),
    median: Number(percentile(samples, 0.5).toFixed(2)),
    p10: Number(percentile(samples, 0.1).toFixed(2)),
    p90: Number(percentile(samples, 0.9).toFixed(2)),
    p95: Number(percentile(samples, 0.95).toFixed(2)),
    overProbability: overCount == null ? null : Number((overCount / samples.length).toFixed(4)),
    underProbability: overCount == null ? null : Number((1 - overCount / samples.length).toFixed(4)),
    standardDeviation: Number(standardDeviation.toFixed(2)),
    distribution,
  };
}
