// ─── ESPN Public API — no key required ──────────────────────
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer";

// FIFA / international slugs to query
const FIFA_LEAGUES = [
  { slug: "fifa.world",          name: "FIFA World Cup" },
  { slug: "fifa.worldq.uefa",    name: "WC Qualifying - UEFA" },
  { slug: "fifa.worldq.concacaf",name: "WC Qualifying - CONCACAF" },
  { slug: "fifa.worldq.afc",     name: "WC Qualifying - AFC" },
  { slug: "fifa.worldq.caf",     name: "WC Qualifying - CAF" },
  { slug: "fifa.worldq.conmebol",name: "WC Qualifying - CONMEBOL" },
  { slug: "uefa.nations",        name: "UEFA Nations League" },
  { slug: "uefa.euro",           name: "UEFA Euro" },
  { slug: "uefa.euroq",          name: "UEFA Euro Qualifying" },
  { slug: "fifa.friendly",       name: "International Friendly" },
  { slug: "fifa.cwc",            name: "FIFA Club World Cup" },
  { slug: "fifa.intercontinental_cup", name: "FIFA Intercontinental Cup" },
];

// Cache
const cache = {};
const TTL = { live: 60_000, upcoming: 300_000, results: 300_000 };

// ─── Init ────────────────────────────────────────────────────
let activeTab = "live";

document.addEventListener("DOMContentLoaded", () => {
  bindTabs();
  document.getElementById("refreshBtn").addEventListener("click", onRefresh);
  loadTab("live");
});

function bindTabs() {
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.tab === activeTab) return;
      activeTab = btn.dataset.tab;
      document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tab-pane").forEach(p => p.classList.toggle("active", p.id === `tab-${activeTab}`));
      loadTab(activeTab);
    });
  });
}

function onRefresh() {
  const btn = document.getElementById("refreshBtn");
  btn.classList.add("spin");
  delete cache[activeTab];
  loadTab(activeTab).finally(() => setTimeout(() => btn.classList.remove("spin"), 500));
}

// ─── Load Tab ────────────────────────────────────────────────
async function loadTab(tab) {
  const pane = document.getElementById(`tab-${tab}`);
  const now = Date.now();

  if (cache[tab] && now - cache[tab].ts < TTL[tab]) {
    render(tab, cache[tab].data);
    return;
  }

  pane.innerHTML = spinner();

  try {
    let data;
    if (tab === "live")     data = await fetchAll("live");
    if (tab === "upcoming") data = await fetchAll("upcoming");
    if (tab === "results")  data = await fetchAll("results");

    cache[tab] = { ts: Date.now(), data };
    render(tab, data);
    setFooter(`Updated ${now12()}`);
  } catch (e) {
    pane.innerHTML = errorBox(e.message);
    setFooter("Error fetching data");
  }
}

// ─── ESPN Fetch ───────────────────────────────────────────────
async function fetchAll(type) {
  const results = await Promise.allSettled(
    FIFA_LEAGUES.map(lg => fetchLeague(lg, type))
  );

  const events = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      r.value.forEach(ev => {
        ev._leagueName = FIFA_LEAGUES[i].name;
        events.push(ev);
      });
    }
  });

  // Strict status filter — no upcoming leaking into results
  const filtered = events.filter(ev => {
    const st = ev._statusType;
    if (type === "live")     return st === "in";
    if (type === "upcoming") return st === "pre";
    if (type === "results")  return st === "post";
    return false;
  });

  // Results: most recent first. Upcoming/live: soonest first.
  if (type === "results") {
    filtered.sort((a, b) => new Date(b.date) - new Date(a.date));
  } else {
    filtered.sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  // For live/results, enrich each match with full scoring plays
  if (type === "live" || type === "results") {
    await Promise.allSettled(
      filtered.map(ev => enrichWithScoringPlays(ev))
    );
  }

  return filtered;
}

// Fetch the full event summary to get ALL scoring plays (goals + cards)
async function enrichWithScoringPlays(ev) {
  try {
    const url = `${ESPN}/${ev._leagueSlug}/summary?event=${ev.id}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const json = await res.json();

    // ── Goals from scoringPlays ──────────────────────────────
    // ESPN soccer: scoringPlays[] each has:
    //   { type:{text}, clock:{displayValue}, team:{id,displayName,$ref}, athletesInvolved:[{displayName}] }
    // team can be a $ref string or an object — normalise both
    const rawPlays = json.scoringPlays || [];
    if (rawPlays.length > 0) {
      ev.details = rawPlays.map(p => {
        // team may be {id, displayName} or a $ref string — extract id from either
        let teamId   = "";
        let teamName = "";
        if (typeof p.team === "object" && p.team !== null) {
          teamId   = String(p.team.id   || "");
          teamName = p.team.displayName || p.team.name || "";
          // if only $ref present, extract id from URL …/teams/123
          if (!teamId && p.team.$ref) {
            const m = String(p.team.$ref).match(/\/teams\/(\d+)/);
            if (m) teamId = m[1];
          }
        }
        // clock: "39'" or "39" — strip apostrophe
        const clockRaw = (p.clock?.displayValue || "").replace(/'/g, "").trim();
        return {
          type:             { text: p.type?.text || "Goal" },
          clock:            { displayValue: clockRaw },
          team:             { id: teamId, displayName: teamName },
          athletesInvolved: p.athletesInvolved || [],
        };
      });
    }

    // ── Cards from plays[] ────────────────────────────────────
    // ESPN soccer summary may have a plays[] array with card events
    const allPlays = json.plays || [];
    const cardTypes = new Set(["Yellow Card", "Red Card", "Yellow-Red Card"]);
    const cardPlays = allPlays.filter(p => cardTypes.has(p.type?.text || ""));
    if (cardPlays.length > 0) {
      ev.cardDetails = cardPlays.map(p => {
        let teamId = "", teamName = "";
        if (typeof p.team === "object" && p.team !== null) {
          teamId   = String(p.team.id || "");
          teamName = p.team.displayName || p.team.name || "";
          if (!teamId && p.team.$ref) {
            const m = String(p.team.$ref).match(/\/teams\/(\d+)/);
            if (m) teamId = m[1];
          }
        }
        const clockRaw = (p.clock?.displayValue || "").replace(/'/g, "").trim();
        return {
          type:             { text: p.type?.text || "" },
          clock:            { displayValue: clockRaw },
          team:             { id: teamId, displayName: teamName },
          athletesInvolved: p.athletesInvolved || [],
        };
      });
    }
  } catch (_) { /* use scoreboard details as fallback */ }
}

async function fetchLeague(lg, type) {
  let url = `${ESPN}/${lg.slug}/scoreboard`;

  if (type === "upcoming") {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    url += `?dates=${yyyymmdd(new Date())}-${yyyymmdd(d)}`;
  } else if (type === "results") {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    url += `?dates=${yyyymmdd(d)}-${yyyymmdd(new Date())}`;
  }

  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  const events = json.events || [];

  return events.map(ev => {
    const comp   = ev.competitions?.[0];
    const home   = comp?.competitors?.find(c => c.homeAway === "home");
    const away   = comp?.competitors?.find(c => c.homeAway === "away");
    const status = comp?.status;

    return {
      id:           ev.id,
      date:         ev.date,
      _statusType:  status?.type?.state || "pre",
      _elapsed:     status?.type?.shortDetail || "",
      _leagueSlug:  lg.slug,
      homeTeam:     teamInfo(home),
      awayTeam:     teamInfo(away),
      homeScore:    home?.score ?? null,
      awayScore:    away?.score ?? null,
      city:         comp?.venue?.address?.city || "",
      details:      comp?.details || [],  // fallback; overwritten by enrichWithScoringPlays
      cardDetails:  [],
      _leagueName:  lg.name,
    };
  });
}

function teamInfo(c) {
  if (!c) return { id: "", name: "TBD", abbr: "TBD", logo: "", winner: false };
  return {
    id:     c.team?.id || "",
    name:   c.team?.displayName || c.team?.name || "TBD",
    abbr:   c.team?.abbreviation || "",
    logo:   c.team?.logo || "",
    winner: c.winner || false,
  };
}

// ─── Render ───────────────────────────────────────────────────
function render(tab, events) {
  const pane = document.getElementById(`tab-${tab}`);

  if (!events.length) {
    pane.innerHTML = emptyBox(tab);
    return;
  }

  let html = '<div class="match-list">';

  if (tab === "upcoming" || tab === "results") {
    // Group by date
    const groups = {};
    events.forEach(ev => {
      const key = dateLabel(ev.date);
      if (!groups[key]) groups[key] = [];
      groups[key].push(ev);
    });
    Object.entries(groups).forEach(([label, evs]) => {
      html += `<div class="date-divider">${label}</div>`;
      evs.forEach(ev => { html += cardHTML(ev, tab); });
    });
  } else {
    events.forEach(ev => { html += cardHTML(ev, tab); });
  }

  html += "</div>";
  pane.innerHTML = html;
}

function cardHTML(ev, tab) {
  const isLive = ev._statusType === "in";
  const isFT   = ev._statusType === "post";
  const isHT   = ev._elapsed?.toLowerCase().includes("half");
  const scored  = isLive || isHT || isFT;

  let cardClass = "card";
  if (isLive || isHT) cardClass += " is-live";
  if (isFT)           cardClass += " is-ft";

  // Badge
  let badgeClass = "badge badge-upcoming", badgeText = "";
  if (isHT)        { badgeClass = "badge badge-ht";       badgeText = "⏸ Half Time"; }
  else if (isLive) { badgeClass = "badge badge-live";     badgeText = `🔴 ${ev._elapsed}`; }
  else if (isFT)   { badgeClass = "badge badge-ft";       badgeText = "Full Time"; }
  else             { badgeClass = "badge badge-upcoming"; badgeText = fmtUpcoming(ev.date); }

  const hs = ev.homeScore ?? 0;
  const as = ev.awayScore ?? 0;
  const hWin = isFT && ev.homeTeam.winner;
  const aWin = isFT && ev.awayTeam.winner;

  const logo = (team) => team.logo
    ? `<img class="team-logo" src="${team.logo}" alt="" onerror="this.style.display='none'"/>`
    : `<span class="team-logo-placeholder">🏴</span>`;

  // ── Score row: [logo name] [score–score] [name logo] ──
  let middleHTML;
  if (scored) {
    const hScoreCls = "match-score" + (hWin ? " score-win" : aWin ? " score-lose" : "");
    const aScoreCls = "match-score" + (aWin ? " score-win" : hWin ? " score-lose" : "");
    middleHTML = `
      <div class="match-row">
        <div class="match-team-home">
          ${logo(ev.homeTeam)}
          <span class="match-name home-name${hWin ? " winner" : ""}">${escHtml(ev.homeTeam.name)}</span>
        </div>
        <div class="match-scorebox">
          <span class="${hScoreCls}">${hs}</span>
          <span class="score-sep">–</span>
          <span class="${aScoreCls}">${as}</span>
        </div>
        <div class="match-team-away">
          <span class="match-name away-name${aWin ? " winner" : ""}">${escHtml(ev.awayTeam.name)}</span>
          ${logo(ev.awayTeam)}
        </div>
      </div>`;
  } else {
    const d = new Date(ev.date);
    const time = d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
    middleHTML = `
      <div class="match-row">
        <div class="match-team-home">
          ${logo(ev.homeTeam)}
          <span class="match-name home-name">${escHtml(ev.homeTeam.name)}</span>
        </div>
        <div class="match-scorebox">
          <span class="ko-time">${time}</span>
        </div>
        <div class="match-team-away">
          <span class="match-name away-name">${escHtml(ev.awayTeam.name)}</span>
          ${logo(ev.awayTeam)}
        </div>
      </div>`;
  }

  if (ev.city) {
    middleHTML += `<div class="venue">📍 ${escHtml(ev.city)}</div>`;
  }

  // ── Events: goals always; cards only for live ──
  let eventsHTML = "";
  if (scored) {
    // Robust team side resolver — tries id match (string-normalised), then name match
    const sideIsHome = (d) => {
      const dId   = String(d.team?.id   || "").trim();
      const dName = String(d.team?.displayName || d.team?.name || "").trim();
      const hId   = String(ev.homeTeam.id  || "").trim();
      const hName = String(ev.homeTeam.name || "").trim();
      if (dId && hId)   return dId === hId;
      if (dName)        return dName === hName;
      return true; // unknown → home as fallback
    };

    const toEvent = (d) => {
      const t     = d.type?.text || "";
      const isOG  = t === "Own Goal";
      // Clock: strip trailing apostrophe ESPN sometimes adds, keep "+N" for extra time
      const rawMin = String(d.clock?.displayValue || "?").replace(/['"]/g, "").trim();
      const minSort = parseFloat(rawMin.replace("+", ".")) || 0;
      const scorer  = d.athletesInvolved?.[0]?.displayName || (isOG ? "OG" : "–");
      const label   = isOG ? `${scorer} (og)` : scorer;
      const icon    = t === "Yellow Card"                           ? "🟨"
                    : t === "Red Card" || t === "Yellow-Red Card"  ? "🟥"
                    : "⚽";
      return { icon, minSort, rawMin, label, isHome: sideIsHome(d) };
    };

    // Goals always shown; cards only when live
    const goalDets = (ev.details || []).filter(d => {
      const t = d.type?.text || "";
      return t === "Goal" || t === "Own Goal";
    });
    const cardDets = isLive
      ? (ev.cardDetails?.length ? ev.cardDetails : ev.details || []).filter(d => {
          const t = d.type?.text || "";
          return t === "Yellow Card" || t === "Red Card" || t === "Yellow-Red Card";
        })
      : [];

    const allEvents = [...goalDets, ...cardDets]
      .map(toEvent)
      .sort((a, b) => a.minSort - b.minSort);

    const homeEvents = allEvents.filter(e =>  e.isHome);
    const awayEvents = allEvents.filter(e => !e.isHome);

    if (homeEvents.length || awayEvents.length) {
      // Home side: minute icon name  →  left aligned
      const homeLines = homeEvents.map(e => `
        <div class="ev-line-home">
          <span class="ev-min">${escHtml(e.rawMin)}'</span>
          <span class="ev-icon">${e.icon}</span>
          <span class="ev-name">${escHtml(e.label)}</span>
        </div>`).join("");

      // Away side: name icon minute  →  right aligned
      const awayLines = awayEvents.map(e => `
        <div class="ev-line-away">
          <span class="ev-name">${escHtml(e.label)}</span>
          <span class="ev-icon">${e.icon}</span>
          <span class="ev-min">${escHtml(e.rawMin)}'</span>
        </div>`).join("");

      eventsHTML = `
        <div class="events-row">
          <div class="ev-home">${homeLines}</div>
          <div class="ev-divider"></div>
          <div class="ev-away">${awayLines}</div>
        </div>`;
    }
  }

  return `
    <div class="${cardClass}">
      <div class="card-top">
        <span class="comp-name">${escHtml(ev._leagueName)}</span>
        <span class="${badgeClass}">${badgeText}</span>
      </div>
      ${middleHTML}
      ${eventsHTML}
    </div>`;
}

// ─── Helpers ──────────────────────────────────────────────────
function yyyymmdd(d) {
  return d.toISOString().slice(0,10).replace(/-/g,"");
}

function dateLabel(dateStr) {
  const d = new Date(dateStr);
  const today = new Date();
  const tom = new Date(); tom.setDate(tom.getDate()+1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === tom.toDateString())   return "Tomorrow";
  return d.toLocaleDateString([],{weekday:"short",month:"short",day:"numeric"});
}

function fmtUpcoming(dateStr) {
  const d = new Date(dateStr);
  const today = new Date();
  const tom   = new Date(); tom.setDate(tom.getDate()+1);
  const time  = d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  if (d.toDateString() === tom.toDateString())   return `Tomorrow ${time}`;
  return `${d.toLocaleDateString([],{month:"short",day:"numeric"})} ${time}`;
}

function now12() {
  return new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
}

function setFooter(msg) {
  document.getElementById("footerText").textContent = msg;
}

function escHtml(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function spinner() {
  return `<div class="spinner-wrap"><div class="spinner"></div> Loading…</div>`;
}

function emptyBox(tab) {
  const msgs = {
    live:     ["😴","No live matches right now","Check the Upcoming tab for next fixtures"],
    upcoming: ["📭","No upcoming fixtures found","Try again later"],
    results:  ["📋","No recent results","Check back after matches complete"],
  };
  const [icon, title, sub] = msgs[tab];
  return `<div class="state-box"><div class="state-icon">${icon}</div><div class="state-title">${title}</div><div class="state-sub">${sub}</div></div>`;
}

function errorBox(msg) {
  return `<div class="state-box"><div class="state-icon">⚠️</div><div class="state-title">Could not load data</div><div class="state-sub">${escHtml(msg)}</div></div>`;
}
