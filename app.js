// fpl-agent console front-end. Vanilla JS, no build step, no framework.
//
// GOVERNING RULE: this file only ever DISPLAYS what data/*.json already
// says. It must never fetch a live FPL/PingOne endpoint itself (that is
// the Worker's job, Phase 3) and it must never derive a number that isn't
// already a field in the JSON -- if a page needs a number the JSON doesn't
// have, that is a gap in build_site.py, not something to compute here.
//
// Every render function is defensive against a missing/partial JSON file:
// Phase 1 ships current/history/health only, and even those can be thin on
// a fresh checkout with no decision records. A page that throws on missing
// data is worse than a page that says so plainly.

(function () {
  'use strict';

  var DATA_BASE = 'data/';
  // The Cloudflare Worker's origin for POST /action (Phase 3). Blank until
  // the Worker is deployed with a known URL -- when blank, the action panel
  // renders its controls but every button is disabled with a message
  // saying why, rather than silently POSTing to a relative path that
  // resolves to the Pages origin itself and 404s. Set this once the Worker
  // is live (cloudflare/approval-worker/README.md has the deploy steps).
  // The Worker's live domain -- confirmed reachable (curl -I returns the
  // existing /decide route's own 400 for a malformed request, not a DNS
  // failure) but the /fpl and /action ROUTES THIS SESSION WROTE are not
  // yet deployed there: this machine has no Cloudflare account access
  // (no `wrangler login` session, confirmed 2026-09-06) to push an
  // update, and the Worker was originally deployed manually by the owner
  // from wherever that access exists. Every button below will 404 on
  // /action until that update ships from a session that CAN deploy it.
  var ACTION_WORKER_URL = 'https://fpl-approval.approval-worker.workers.dev';
  // Where the owner's action token lives once entered via the Settings
  // control below. Per-browser only (localStorage never reaches the
  // server or other viewers) -- the token itself is never sent anywhere
  // except as the Authorization header on a /action call to the Worker.
  var TOKEN_STORAGE_KEY = 'fpl-console-action-token';

  function getActionToken() {
    try { return window.localStorage.getItem(TOKEN_STORAGE_KEY) || ''; }
    catch (e) { return ''; }
  }
  function setActionToken(value) {
    try {
      if (value) window.localStorage.setItem(TOKEN_STORAGE_KEY, value);
      else window.localStorage.removeItem(TOKEN_STORAGE_KEY);
      return true;
    } catch (e) { return false; }
  }

  function $(id) { return document.getElementById(id); }
  // OWNER-CAUGHT 2026-09-07 (failure-swallow sweep): every render*() call
  // in the boot Promise.all is wrapped in try/catch with console.error
  // only -- a throw left that tab's static placeholders in place with
  // NOTHING on the page indicating it. renderStrip's own crash (an
  // undeclared variable) went unnoticed through several real builds
  // this exact way. Every catch below now also calls this, so a reader
  // sees SOMETHING broke even if they never open devtools.
  function renderError(section, e) {
    console.error('[console] ' + section + ':', e);
    var el = $('render-errors');
    if (!el) return;
    el.hidden = false;
    var p = document.createElement('p');
    p.textContent = section + ' failed to render: ' + (e && e.message ? e.message : e);
    el.appendChild(p);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(x, d) {
    if (x == null || isNaN(x)) return '—';
    return Number(x).toFixed(d == null ? 2 : d);
  }
  // OWNER-CAUGHT 2026-09-07 (copy pass): "objective 301.8" gave no unit,
  // no horizon, no basis -- a bare number. Derived from src/optimiser.py
  // directly: objective_xp sums the WEIGHTED (decayed) projected points
  // of the whole squad (XI at full weight, bench at its own autosub
  // weight) over objective_mode's horizon (membership_h5 = 5 gameweeks,
  // decayed; membership_h1 = 1 gameweek, used for one-week chip
  // decisions like free-hit), plus the captain's NEXT-gameweek points
  // once more (the doubling), minus 4 points per paid transfer hit. A
  // small vice-captain tie-break and transfer-banking nudge are folded
  // in too (each <=0.01 weight -- do not change how the number reads).
  function objectiveLabel(mode) {
    return mode === 'membership_h1'
      ? 'squad points, 1 gameweek, captain doubled, minus hit cost'
      : 'squad points, 5-gameweek weighted total, captain doubled, minus hit cost';
  }

  // -------------------------------------------------------------------
  // TIME FORMATTING (owner-directed 2026-09-08 date/time sweep). Mirrors
  // src/fmt_time.py line for line -- Python formats email/Telegram text,
  // this formats the console, and NOTHING renders a raw ISO string with
  // a trailing Z to a reader in either place. Kept as two files (no
  // shared runtime between a GitHub Actions Python process and a
  // static-hosted browser page) but tests/test_fmt_time.py and this
  // file's own FMT_TIME_SELFTEST use the IDENTICAL fixture timestamps
  // so the two cannot silently drift to different answers.
  // -------------------------------------------------------------------
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // SAST is a fixed UTC+2 offset, no DST -- unlike the UK check below,
  // this needs no rule at all.
  function toSAST(dt) {
    return new Date(dt.getTime() + 2 * 3600000);
  }
  function fmtParts(dt) {
    return pad2(dt.getUTCDate()) + '/' + pad2(dt.getUTCMonth() + 1) + '/' +
      dt.getUTCFullYear() + ' ' + pad2(dt.getUTCHours()) + ':' + pad2(dt.getUTCMinutes());
  }
  // The UK alternates BST/GMT (last Sunday of March 01:00 UTC -- last
  // Sunday of October 01:00 UTC, the real EU rule) -- computed, not a
  // hardcoded date range, same reasoning as src/fmt_time.py's
  // _uk_is_bst(). A fixed "March-October" range would pass on typical
  // dates and mis-time the transition day itself.
  function lastSundayUTC(year, month /* 0-indexed */) {
    var d = new Date(Date.UTC(year, month + 1, 0, 1, 0, 0)); // last day of month, 01:00 UTC
    while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() - 1);
    return d;
  }
  function ukIsBst(dtUtc) {
    var year = dtUtc.getUTCFullYear();
    var bstStart = lastSundayUTC(year, 2);  // March
    var bstEnd = lastSundayUTC(year, 9);    // October
    return dtUtc >= bstStart && dtUtc < bstEnd;
  }
  function toUK(dt) {
    return new Date(dt.getTime() + (ukIsBst(dt) ? 1 : 0) * 3600000);
  }

  // '2026-09-12T12:30:00Z' -> '12/09/2026 14:30 SAST'. '' (never the
  // raw input echoed back) on anything unparseable.
  function formatTime(value) {
    if (!value) return '';
    var ms = Date.parse(value);
    if (isNaN(ms)) return '';
    return fmtParts(toSAST(new Date(ms))) + ' SAST';
  }
  // Same, plus the UK local time in brackets -- ONLY for the FPL
  // deadline, which is SET in UK time at source.
  function formatDeadline(value) {
    if (!value) return '';
    var ms = Date.parse(value);
    if (isNaN(ms)) return '';
    var dt = new Date(ms);
    var sastStr = fmtParts(toSAST(dt)) + ' SAST';
    var ukZone = ukIsBst(dt) ? 'BST' : 'GMT';
    var ukStr = fmtParts(toUK(dt)) + ' ' + ukZone;
    return sastStr + ' (' + ukStr + ' UK)';
  }
  // Any raw ISO timestamp embedded in a free-text note (e.g. health.json's
  // own "unknown -- no probe since 2026-09-06T17:26:10Z") is reformatted
  // in place, since that text is built server-side and can't be changed
  // at the source without touching build_health() itself.
  function reformatEmbeddedTimestamps(s) {
    return String(s == null ? '' : s).replace(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g,
      function (m) { return formatTime(m) || m; });
  }

  // Self-test, run once at load: the SAME fixture timestamps as
  // tests/test_fmt_time.py, so a change to either file that breaks
  // agreement is visible in the browser console immediately rather
  // than discovered by comparing an email to the page days later.
  (function fmtTimeSelfTest() {
    var cases = [
      [formatTime('2026-01-12T10:00:00Z'), '12/01/2026 12:00 SAST'],
      [formatTime('2026-07-12T10:00:00Z'), '12/07/2026 12:00 SAST'],
      [formatTime('2026-09-12T23:00:00Z'), '13/09/2026 01:00 SAST'],
      [formatDeadline('2026-09-12T12:30:00Z'), '12/09/2026 14:30 SAST (12/09/2026 13:30 BST UK)'],
      [formatDeadline('2026-01-12T12:30:00Z'), '12/01/2026 14:30 SAST (12/01/2026 12:30 GMT UK)'],
    ];
    cases.forEach(function (c) {
      if (c[0] !== c[1]) {
        console.error('[console] formatTime self-test MISMATCH: got "' + c[0] + '", expected "' + c[1] + '"');
      }
    });
  })();
  function fetchJson(name) {
    return fetch(DATA_BASE + name, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
      return r.json();
    });
  }
  // Every consumer of a data file goes through this, so a MISSING file (a
  // page not yet built, e.g. scorecard.json before Phase 2) reaches the
  // caller as {} rather than an uncaught rejection -- the spec requires
  // all seven pages to render without error on an empty/absent contract.
  function loadOrEmpty(name) {
    return fetchJson(name).catch(function (e) {
      console.warn('[console] ' + name + ' unavailable:', e.message);
      return {};
    });
  }

  // -------------------------------------------------------------------
  // tabs
  // -------------------------------------------------------------------
  function initTabs() {
    var tabs = document.querySelectorAll('.nav [role="tab"]');
    var panels = {};
    document.querySelectorAll('[role="tabpanel"]').forEach(function (p) {
      panels[p.id.replace('tab-', '')] = p;
    });
    function show(id, scroll) {
      tabs.forEach(function (t) {
        t.setAttribute('aria-selected', String(t.dataset.tab === id));
      });
      Object.keys(panels).forEach(function (k) {
        panels[k].hidden = (k !== id);
      });
      try { localStorage.setItem('fpl-console-tab', id); } catch (e) { /* private mode */ }
      if (scroll) {
        var m = document.querySelector('main');
        if (m && m.scrollIntoView) m.scrollIntoView({ block: 'start' });
      }
    }
    tabs.forEach(function (t) {
      t.addEventListener('click', function () { show(t.dataset.tab, true); });
    });
    var saved = null;
    try { saved = localStorage.getItem('fpl-console-tab'); } catch (e) { /* ignore */ }
    show(saved && panels[saved] ? saved : 'week', false);
  }

  // -------------------------------------------------------------------
  // status strip + nav counts (from current.json + history.json + health.json)
  // -------------------------------------------------------------------
  // GW settlement-state labels, shared with the brand line and the
  // deadline cell -- one source of English for the three states
  // build_site.py's _gw_settlement_state() can report, so the brand line
  // and the deadline cell cannot disagree about which state a gameweek
  // is actually in.
  var GW_STATE_LABEL = {
    settled: 'settled', in_progress: 'in progress',
    awaiting_settlement: 'awaiting settlement', unknown: 'state unknown',
  };

  function renderStrip(current, history, health) {
    var rec = current || {};
    var gw = rec.gw;
    var gwStatus = rec.gameweek_status || {};
    var settlement = gwStatus.settlement || {};
    var stateWord = GW_STATE_LABEL[settlement.state] || 'state unknown';
    $('brand-sub').textContent = 'you decide, the system proposes' +
      (gw ? ' · gameweek ' + gw + ' ' + stateWord : '');
    $('nav-count-week').textContent = gw ? 'GW' + gw : '–';
    // The sidebar badge stays as the short 'GW4' form deliberately -- it
    // sits directly beside its own tab label ("This week"), not in a
    // sentence, and every other place this number appears on the page
    // (the h1, the status strip, the brand line above) already spells
    // "gameweek N" in full at least once before this badge is seen.
    $('nav-count-history').textContent = (history.entries || []).length || '–';

    var flags = (health.chronic_flags || []);
    // A flag needing attention is firing OR unknown (a lookup that
    // couldn't be checked is not the same as clear -- owner-caught
    // 2026-09-06) -- both belong in the nav badge's count, only a
    // CONFIRMED clear should not.
    //
    // OWNER-CAUGHT 2026-09-08: a THIRD non-badge-counted state exists
    // now -- 'info' (floored_negative, retired as a gating condition,
    // kept as a real reported number -- see build_site.py's own
    // comment on that flag). 'info' must read like 'clear' for badge/
    // verdict purposes (it never blocks approval, matching what
    // narrate.py's money-gating code actually does) while still
    // rendering its own distinct, non-green square below -- so it is
    // excluded HERE, alongside 'clear', rather than folded into the
    // generic "anything not clear counts" rule.
    var needsAttention = flags.filter(function (f) {
      var st = f.state || (f.firing ? 'firing' : 'clear');
      return st !== 'clear' && st !== 'info';
    }).length;
    $('nav-count-health').textContent = flags.length ? (needsAttention + ' flags') : '–';
    var healthCount = $('nav-count-health');
    healthCount.className = 'count' + (needsAttention > 0 ? ' warn' : '');

    // DEADLINE: the actual timestamp from the record's own gameweek_status
    // (built_site.py's build_current(), reading bootstrap-static's own
    // deadline_time) -- never a word like "GW3 record", which is exactly
    // the defect owner-caught 2026-09-06. If awaiting settlement, the
    // cell also states what it is waiting on and what will be graded,
    // rather than leaving the reader to guess why GW3 (past its
    // deadline, unsettled) shows nothing.
    var deadlineEl = $('strip-deadline');
    if (gwStatus.deadline) {
      var waiting = settlement.waiting_on || {};
      var stateSuffix = settlement.state === 'awaiting_settlement'
        ? ' — waiting for the match(es) to finish' +
          (!waiting.finished ? '' : ' and for the final stats to be checked')
        : (settlement.state === 'settled' ? ' — settled'
           : (settlement.state === 'in_progress' ? ' — in progress' : ''));
      // FPL DEADLINE, specifically: SAST + UK time in brackets (owner-
      // directed 2026-09-08 -- the deadline is SET in UK time, so
      // showing only its SAST conversion hides the number that actually
      // governs it).
      deadlineEl.textContent = formatDeadline(gwStatus.deadline) + stateSuffix;
      deadlineEl.title = settlement.will_grade || '';
    } else {
      deadlineEl.textContent = '—';
      deadlineEl.title = '';
    }

    // TIME LEFT TO CHANGE YOUR MIND (was "WINDOWS", owner-directed
    // 2026-09-08 jargon sweep): src/approval.py holds a proposal open
    // for you to reject before it takes effect -- normally 6 hours, or
    // just 30 minutes if the proposal was made close enough to the
    // deadline that a full 6 hours would run past it. Read from
    // src/approval.py's own constants via the record -- never a stored
    // countdown number (which goes stale the instant the build
    // finishes). The deadline countdown itself is computed HERE, in the
    // browser, from the timestamp above, recomputed on every render.
    var windowsEl = $('strip-windows');
    if (gwStatus.windows && gwStatus.deadline) {
      var w = gwStatus.windows;
      var deadlineMs = Date.parse(gwStatus.deadline);
      var nowMs = Date.now();
      var msToDeadline = deadlineMs - nowMs;
      var countdownTxt;
      if (isNaN(deadlineMs)) {
        countdownTxt = '';
      } else if (msToDeadline > 0) {
        var hrs = msToDeadline / 3600000;
        countdownTxt = hrs >= 1 ? num(hrs, 1) + 'h until the deadline'
          : Math.round(msToDeadline / 60000) + 'm until the deadline';
      } else {
        countdownTxt = Math.round(-msToDeadline / 60000) + 'm past the deadline';
      }
      windowsEl.textContent = w.weekly_hours + 'h to reject a proposal normally, ' +
        w.late_minutes + 'm if made close to the deadline' +
        (countdownTxt ? ' · ' + countdownTxt : '');
    } else {
      windowsEl.textContent = '—';
    }

    // SESSION: the fixed wording. "unknown" now always carries a time
    // (health.session.note names it directly, e.g. "unknown -- no probe
    // since 2026-09-06T17:26:10Z"), never the bare, broken-sounding
    // phrase this replaced.
    var sess = health.session || {};
    var sEl = $('strip-session');
    if (sess.idp_status === 200 && sess.fpl_status === 200) {
      sEl.innerHTML = '<i class="dot good"></i>alive' +
        (sess.access_token_exp ? ' · login expires ' + esc(formatTime(sess.access_token_exp) || sess.access_token_exp) : '');
    } else if (sess.idp_status || sess.fpl_status) {
      sEl.innerHTML = '<i class="dot crit"></i>degraded (login service ' + esc(sess.idp_status) +
        ', FPL site ' + esc(sess.fpl_status) + ')';
    } else {
      sEl.innerHTML = '<i class="dot warn"></i>' + esc(reformatEmbeddedTimestamps(sess.note || 'unknown'));
    }

    // ESTIMATOR: the commit short-SHA that was live at this gameweek's
    // deadline (gameweek_status.estimator, the SAME lookup analytics.json's
    // estimator_versions section uses) -- not the freeze-validation
    // "changed_at/unvalidated" concept, which stays on the Health TAB
    // (renderHealth's own #health-estimator) where it already lives.
    var stripEst = gwStatus.estimator || {};
    $('strip-estimator').textContent = stripEst.commit
      ? stripEst.commit.slice(0, 10)
      : '—';
    if (stripEst.subject) {
      $('strip-estimator').title = 'The scoring model version used to make this week\'s projections: "' +
        stripEst.subject + '"' +
        (stripEst.committed_at ? ' (changed ' + formatTime(stripEst.committed_at) + ')' : '') +
        '. The code shown above is its internal version number.';
    }

    // OWNER-CAUGHT 2026-09-07 (copy pass): "N of 5 firing" is a count,
    // not the verdict it implies. approval.requires_explicit_approval()
    // (src/approval.py) treats ANY chronic flag firing as a reason this
    // week's proposal must be explicitly approved, never default-
    // submitted -- so the real, derived fact a reader needs is whether
    // THIS WEEK's picks can be trusted as-is, and if not, which checks
    // are why. Reused needsAttention (already computed above for the
    // nav badge) rather than a separate count -- this ALSO fixes a live
    // bug: this cell referenced an undeclared `firing` variable (removed
    // when needsAttention replaced it, this use site was missed),
    // throwing a ReferenceError caught by the top-level try/catch around
    // renderStrip -- meaning this cell had shown only its static
    // placeholder ('—') on every real build since that edit landed,
    // never actually rendering a verdict at all.
    var fEl = $('strip-flags');
    if (flags.length) {
      if (needsAttention === 0) {
        fEl.innerHTML = '<i class="dot good"></i>trustworthy as-is';
      } else {
        var firingLabels = flags.filter(function (f) {
          return (f.state || (f.firing ? 'firing' : 'clear')) !== 'clear';
        }).map(function (f) { return f.label; });
        fEl.innerHTML = '<i class="dot warn"></i>not trustworthy as-is';
        fEl.title = 'Why: ' + firingLabels.join('; ');
      }
    } else {
      fEl.textContent = '—';
    }

    // Page last updated is the primary fact here (owner-directed
    // 2026-09-08 jargon sweep: a filename/build SHA is kept for anyone
    // who needs it, but must not be the first thing a reader meets) --
    // the commit hash is demoted to a parenthetical.
    var built = (current.source && current.source.built_at) || '';
    var commit = (current.source && current.source.commit) || '';
    $('build-foot').textContent = 'Page last updated: ' +
      (built ? formatTime(built) : 'unknown') + (commit ? ' (build ' + commit + ')' : '');
  }

  // -------------------------------------------------------------------
  // THIS WEEK
  // -------------------------------------------------------------------
  // OWNER-CAUGHT 2026-09-07 (copy pass): each card's number was a bare
  // figure with no unit or horizon. Derived from src/decide.py directly
  // -- xp_field stores v[0], the FIRST element of the player's 5-row xP
  // array, i.e. NEXT gameweek's projected points only (not the 5-week
  // weighted total the squad objective uses) -- title attribute states
  // it in full; the card itself stays compact with a "pts" unit suffix.
  function playerCard(id, xf, meta, extraTag) {
    var name = meta && meta[id] ? meta[id].name : ('#' + id);
    // OWNER-CAUGHT 2026-09-11: pitch/bench tiles named the player but
    // not the club he plays for -- a real, requested fact, and one the
    // Field tab already carries per row. player_index now carries
    // 'team' (build_site.py, the same short_name lookup Field's own
    // build_field() uses), shown as a small line under the name.
    var team = meta && meta[id] ? meta[id].team : null;
    var v = xf ? xf[String(id)] : null;
    var xp = v == null ? null : (Array.isArray(v) ? v[0] : v);
    var tagHtml = extraTag ? '<span class="tag' + (extraTag.cls ? ' ' + extraTag.cls : '') +
      '">' + esc(extraTag.text) + '</span>' : '';
    var xpTitle = 'Projected points, next gameweek only';
    return '<div class="pl' + (extraTag && extraTag.isNew ? ' new' : '') + '" title="' +
      esc(xpTitle) + '">' +
      '<b>' + esc(name) + '</b>' +
      (team ? '<span class="club">' + esc(team) + '</span>' : '') +
      '<span class="xp">' + (xp != null ? num(xp, 2) + ' pts' : '—') + '</span>' +
      tagHtml + '</div>';
  }

  function renderWeek(current, field) {
    var rec = current || {};
    if (!rec.gw) {
      $('week-proposal-summary').textContent = 'No decision record yet.';
      $('week-h1').textContent = 'This week — no decision record yet';
      $('week-sub').textContent = 'site/data/current.json has no record. ' +
        'Run execution/build_site.py after a decision has been logged.';
      return;
    }

    // PROPOSAL SUMMARY (owner-caught 2026-09-08): ONE sentence, computed
    // server-side by build_site.py's build_current() from the record's
    // own chip/transfers/hits/chips_eval fields -- this file only
    // displays it, per the module's own governing rule. Everything else
    // on this page is supporting detail for this sentence; it always
    // renders first, above the h1.
    var ps = rec.proposal_summary || {};
    $('week-proposal-summary').innerHTML = ps.headline
      ? '<b>' + esc(ps.headline) + '</b><br>' + esc(ps.if_you_do_nothing || '')
      : 'No proposal summary on this record.';
    // THREE STATUSES, not a boolean: proposed / owner_reported / api_observed.
    // A record can be owner_reported (you told the system directly) without
    // yet being api_observed (confirmed by a post-deadline FPL read) -- the
    // console must say which it has, not collapse both to "your decision".
    var status = rec.decision_status || (rec.is_owner_decision ? 'owner_reported' : 'proposed');
    var owner = status !== 'proposed';
    var statusLabel = { proposed: 'proposed decision',
                        owner_reported: 'reported by you, not yet confirmed',
                        api_observed: 'confirmed by the FPL API' }[status] || 'proposed decision';
    $('week-h1').textContent = 'Gameweek ' + rec.gw + ' — ' + statusLabel;
    var srcRec = (rec.source && rec.source.record) || 'unknown record';
    var srcW = (rec.source && rec.source.record_written) || '';
    var subMap = {
      proposed: 'Proposed; nothing submitted while you review it.',
      owner_reported: 'You told the system what you did, but this has not yet been checked against the FPL API.',
      api_observed: 'Confirmed against a live FPL read after the deadline. Nothing was submitted by the system.',
    };
    // AGE, STATED PLAINLY (owner-caught 2026-09-10): a decision made
    // under an old config value (or before an injury/news update) can
    // sit on the page for days with nothing announcing it might be
    // stale -- confirmed live: the wildcard trigger changed 12.0 ->
    // 50.0 on 2026-09-08, but the deployed console kept showing a
    // wildcard proposal made HOURS BEFORE that change, for 36+ hours,
    // because no new decisions/*.json record had landed in that
    // window (a separate, now-fixed gap: site_build.yml's own push-
    // path filter did not include the routine data/archive/** commits
    // that were the only thing landing). This does not compute a
    // verdict ("stale"/"fresh") -- it states the actual age, next to
    // the record identity, where a reader looks first, and lets them
    // judge it against how close the deadline is.
    var ageTxt = '';
    if (srcW) {
      var _ageMs = Date.now() - Date.parse(srcW);
      if (!isNaN(_ageMs) && _ageMs > 0) {
        var _ageHrs = _ageMs / 3600000;
        ageTxt = _ageHrs >= 24
          ? ' — made ' + (_ageHrs / 24).toFixed(1) + ' days ago'
          : ' — made ' + _ageHrs.toFixed(1) + ' hours ago';
      }
    }
    $('week-sub').textContent = 'Record ' + srcRec +
      (srcW ? ' (' + formatTime(srcW) + ageTxt + ')' : '') + '. ' +
      (subMap[status] || subMap.proposed);

    // The owner block itself, when present: intent / reported / observed,
    // each with its own timestamp, never collapsed into one line.
    var ownerBlock = rec.owner || null;
    if (ownerBlock) {
      var parts = [];
      if (ownerBlock.intent && ownerBlock.intent.value) {
        parts.push('<b>Intent</b> (' + esc(ownerBlock.intent.timestamp) + '): "' +
          esc(ownerBlock.intent.value) + '"');
      }
      var chipRep = ownerBlock.chip_played_owner_reported;
      if (chipRep && chipRep.value) {
        parts.push('<b>Reported chip</b>: ' + esc(chipRep.value) +
          ' (' + esc(chipRep.timestamp) + ')');
      }
      var chipObs = ownerBlock.chip_played_api_observed;
      if (chipObs && chipObs.value) {
        parts.push('<b>API-confirmed chip</b>: ' + esc(chipObs.value) +
          ' (' + esc(chipObs.timestamp) + ')');
      }
      var trObs = ownerBlock.transfers_taken_api_observed;
      if (trObs && trObs.value) {
        parts.push('<b>API-confirmed transfers</b>: ' + esc(trObs.value.made) +
          ' made, ' + esc(trObs.value.cost) + ' point cost (' + esc(trObs.timestamp) + ')');
      }
      if (parts.length) {
        $('week-sub').innerHTML = $('week-sub').textContent + '<br>' + parts.join(' · ');
      }
    }

    // XI as a pitch. squad/xi/bench are the record's own lists (element
    // IDs only -- the record never carries names); names/positions come
    // from current.player_index, built server-side from bootstrap-static
    // (build_site.py's build_current(), scoped to exactly the IDs on
    // THIS record).
    //
    // OWNER-CAUGHT 2026-09-07, TWICE. First: this rendered as a single
    // flat <div class="row"> regardless of formation -- meta was always
    // passed as `null` (never wired to anything), so every name showed
    // as '#id', and #week-pitch's own CSS (display:grid, grid-template-
    // rows:repeat(4,1fr), alternating pitch-stripe bands every 25%) was
    // built for FOUR formation rows that never got emitted. Second, on
    // review: the FIRST fix sourced meta from field.json's players --
    // but field.json is built from the record's OWN xp_decomposition and
    // is DOCUMENTED to be legitimately empty when a record predates that
    // field (test_site_build.py asserts the empty-with-a-note case as
    // CORRECT, not a bug) -- meaning both original defects (id-only
    // names, lost element_type) came straight back from a state the
    // codebase already considers normal. current.player_index has no
    // such dependency: it exists whenever bootstrap_latest.json does,
    // independent of whether this record ever got an xp_decomposition
    // pass. Grouped by position (GKP/DEF/MID/FWD), each in its own .row,
    // so the pitch grid is actually used the way its own CSS was built for.
    var xi = rec.xi || [];
    var bench = rec.bench || [];
    var xf = rec.xp_field || {};
    var tin = rec.transfers_in || [];
    var meta = rec.player_index || {};
    var wcOut = rec.wildcard_out || [];
    var wcIn = rec.wildcard_in || [];
    // field.json's players carry a full per-player decomposition
    // (ep_next = current form, fixture_factor_total = fixture
    // difficulty, odds_term_raw = betting odds) for every player the
    // estimator scored -- the exact breakdown the captain basis and
    // contested-slots panels promised but did not render (owner-
    // directed 2026-09-08, item 6). Indexed once, by id, for both.
    var fieldById = {};
    ((field && field.players) || []).forEach(function (p) { fieldById[p.id] = p; });

    $('week-xi-h2').textContent = 'XI (' + xi.length + ' players)' +
      (rec.objective_xp != null ? ' · ' + num(rec.objective_xp, 1) + ' '
        + objectiveLabel(rec.objective_mode) : '');

    var pitch = $('week-pitch');
    if (xi.length) {
      var POS_ORDER = ['GKP', 'DEF', 'MID', 'FWD'];
      var byPos = { GKP: [], DEF: [], MID: [], FWD: [] };
      var unpositioned = [];
      xi.forEach(function (id) {
        var pos = meta[id] && meta[id].position;
        (byPos[pos] || unpositioned).push(id);
      });
      var cardFor = function (id) {
        var tag = null;
        if (id === rec.captain) tag = { text: (rec.chip === '3xc' ? 'TC ×3' : 'C'), cls: 'tc', isNew: false };
        else if (tin.indexOf(id) !== -1) tag = { text: 'IN', isNew: true };
        return playerCard(id, xf, meta, tag);
      };
      var rowsHtml = POS_ORDER.map(function (pos) {
        return byPos[pos].length
          ? '<div class="row">' + byPos[pos].map(cardFor).join('') + '</div>'
          : '';
      }).join('');
      // A player field.json has no position for (an empty field.json, or
      // an ID it never enriched) still renders -- grouped as its own row
      // rather than silently dropped, so the "11 players" count above
      // never disagrees with what's actually drawn.
      if (unpositioned.length) {
        rowsHtml += '<div class="row">' + unpositioned.map(cardFor).join('') + '</div>';
      }
      pitch.innerHTML = rowsHtml;
    } else {
      pitch.innerHTML = '<p style="color:var(--ink-3);margin:0">No XI on this record.</p>';
    }
    var benchEl = $('week-bench');
    // OWNER-CAUGHT 2026-09-07: bench[0] is STRUCTURALLY the second
    // keeper (the optimiser enforces exactly one GK on the bench, see
    // tests/test_optimiser.py's own "bench[0] not GK" hard check, and
    // it is always list index 0) -- a minimum-price slot never expected
    // to play, that happened to render beside Raya's real 4.83 with
    // nothing distinguishing "this is a budget placeholder" from "this
    // was a genuine pick on its own merits". Tagged here rather than
    // left to a reader to infer from a low number alone. If the price
    // is meaningfully above the position floor, that IS real budget
    // spent on a bench slot -- said plainly instead of the generic tag,
    // per the instruction to surface it when true rather than assume
    // it never is.
    var GK_BUDGET_TOLERANCE = 0.2; // £m above the true floor still reads as "the floor"
    var gkFloor = null;
    (field && field.players || []).forEach(function (p) {
      if (p.position === 'GKP' && (gkFloor === null || p.price < gkFloor)) gkFloor = p.price;
    });
    benchEl.innerHTML = bench.length
      ? bench.map(function (id, idx) {
          var tag = null;
          if (idx === 0) {
            var gkPrice = meta[id] && field && field.players
              ? (field.players.filter(function (p) { return p.id === id; })[0] || {}).price
              : null;
            var aboveFloor = gkFloor != null && gkPrice != null && gkPrice > gkFloor + GK_BUDGET_TOLERANCE;
            // OWNER-CAUGHT 2026-09-11: this tag's text is a full
            // sentence, not a short corner-badge label like 'C'/'IN' --
            // the shared .tag CSS position:absolute'd it directly over
            // the player's own name, making both unreadable. cls:'note'
            // gives it a distinct style (normal block flow, below the
            // name/points, not an absolute-positioned overlay).
            tag = aboveFloor
              ? { text: '2nd GK · £' + num(gkPrice - gkFloor, 1) + 'm above the cheapest option', isNew: false, cls: 'note' }
              : { text: '2nd GK · not expected to play', isNew: false, cls: 'note' };
          }
          return playerCard(id, xf, meta, tag);
        }).join('')
      : '';

    // chips
    var ce = rec.chips_eval || {};
    var chipsEl = $('week-chips');
    var chipHtml = '';
    // OWNER-CAUGHT 2026-09-07: captain_xp/rebuild_gain are computed
    // UNCONDITIONALLY in decide.py (src/decide.py:854, before the
    // available-chips gate is even checked) -- informational arithmetic
    // that exists on the record whether or not the chip is actually
    // playable. This panel used to render a row whenever the NUMBERS
    // existed, with no check against ce.available at all, so a SPENT
    // chip (played in an earlier gameweek, correctly absent from
    // src/chips.py's own candidate evaluation) still rendered here as
    // if it were a live option clearing its bar -- confirmed live: GW3
    // played 3xc (chip_played_pending on that record), and GW4's
    // ce.available correctly excludes '3xc', but this panel still drew
    // "Triple captain -- captain xP over 1 GW -- 8.42 vs 12.0" as
    // though it were on the table. This panel's own heading claims
    // "chips clearing their bar" -- a spent chip is never clearing
    // anything, it cannot be played at all. Now gated on ce.available;
    // a spent-but-would-have-cleared chip gets its own explicit note
    // instead of a live-looking row.
    var avail = ce.available || [];
    if (ce.recommendation || owner) {
      var trig = ce.trigger, cap = ce.captain_xp, rg = ce.rebuild_gain, rg1 = ce.rebuild_gain_1gw;
      var tcAvailable = avail.indexOf('3xc') !== -1;
      var wcAvailable = avail.indexOf('wildcard') !== -1;
      if (cap != null && trig != null && tcAvailable) {
        chipHtml += chipRow('Triple captain', 'captain xP over 1 GW', cap, trig,
          rec.chip === '3xc' ? (owner ? 'OWNER' : 'PROPOSED') : null);
      } else if (cap != null && trig != null && cap > trig) {
        chipHtml += '<p style="margin:0 0 8px;font-size:12.5px;color:var(--ink-3)">' +
          'Triple captain would clear its bar (' + num(cap, 2) + ' vs ' + num(trig, 1) +
          ') but is <b>already spent</b> this half -- not a live option.</p>';
      }
      if (rg != null && trig != null && wcAvailable) {
        // OWNER-DIRECTED 2026-09-07: the render-time caveat that used to
        // sit here (rebuild_gain measured against a single-shot, static-
        // squad baseline) is REMOVED now that the baseline itself is
        // fixed -- decide.py's rebuild_gain is computed via
        // multi_week_free_transfer_baseline(), which simulates the real
        // free-transfer accrual across the horizon (see
        // directives/prereg_multi_week_free_transfer_baseline.md). The
        // figure no longer overstates the case for the chip the way the
        // caveat described, so stating it would now be misleading in
        // the opposite direction.
        chipHtml += chipRow('Wildcard', 'projected squad points, 5 gameweeks, if you keep this squad', rg, trig,
          rec.chip === 'wildcard' ? (owner ? 'OWNER' : 'PROPOSED') :
          (ce.owner_excluded && ce.owner_excluded.indexOf('wildcard') !== -1 ? 'EXCLUDED' : null));
      } else if (rg != null && trig != null && rg > trig) {
        chipHtml += '<p style="margin:0 0 8px;font-size:12.5px;color:var(--ink-3)">' +
          'Wildcard would clear its bar (' + num(rg, 1) + ' vs ' + num(trig, 1) +
          ') but is <b>already spent</b> this half of the season -- not a live option.</p>';
      }
    }
    chipsEl.innerHTML = chipHtml || '<p style="margin:0;color:var(--ink-3);font-size:13px">' +
      'No chip arithmetic on this record.</p>';

    // WILDCARD PLAIN-ENGLISH EXPLAINER (owner-directed 2026-09-08, item
    // 5): "27.07 vs 12.0" tells a reader nothing about whether to spend
    // a limited, once-per-half-season resource. Explains, in order:
    // what a wildcard actually is and how many are left; what playing
    // it now buys, in words, over what period, against what
    // alternative; what it costs (nothing in points, but it is used up
    // -- there are only two per season, one per half); and what the
    // rebuilt squad actually changes, using the in/out lists already
    // built (wcOut/wcIn) rather than repeating the number alone.
    var wcExplainEl = document.getElementById('week-wildcard-explain');
    if (wcExplainEl) {
      if (rec.chip === 'wildcard' && ce.rebuild_gain != null) {
        var halfLabel = ce.half === 'second_half' ? 'second half' : 'first half';
        var nOut = wcOut.length, nIn = wcIn.length;
        // OWNER-CAUGHT 2026-09-08: this used to render "expires if not
        // used this gameweek" whenever ce.expiring_if_unused listed
        // 'wildcard' -- misreading that field. src/chips.py's expiring()
        // reports "available chips whose window closes at the end of
        // THIS HALF" (chip_expiry_gw[half], GW19 for the first half,
        // matching bootstrap-static's own stop_event=19) -- it does NOT
        // mean "this specific gameweek". At GW4 that is 16 gameweeks of
        // runway, not zero -- a false urgency claim pushing toward
        // spending a scarce, irreversible chip. Fixed: renders the REAL
        // window from rec.chip_window (build_site.py, computed from the
        // SAME frozen config chips.py itself reads), with an actual
        // urgency note only when the window is GENUINELY closing soon
        // (2 or fewer gameweeks left, matching chips.py's own capacity-
        // binding logic in spirit) rather than every single pass.
        var win = rec.chip_window;
        var windowTxt = win
          ? (win.gws_remaining + ' gameweek' + (win.gws_remaining !== 1 ? 's' : '') +
             ' left to play it (through gameweek ' + win.expiry_gw + ') before this half\'s wildcard is lost.')
          : 'Its window for this half of the season is not available on this record.';
        var genuinelyClosing = win && win.gws_remaining <= 2;
        wcExplainEl.innerHTML =
          '<p style="margin:0 0 8px">A <b>wildcard</b> lets you rebuild your whole squad in one go, with ' +
          'no points deducted for any number of changes. You get exactly <b>two per season</b>, one to use ' +
          'in the first half and one in the second — once used, that half\'s wildcard is gone, whether or ' +
          'not you use every free swap it allows.</p>' +
          '<p style="margin:0 0 8px">This would be your ' + esc(halfLabel) + ' wildcard. Playing it now is ' +
          'projected to score <b>' + num(ce.rebuild_gain, 1) + ' more points over the next 5 gameweeks</b> ' +
          'than keeping your current squad and using ordinary free transfers instead (the bar for "worth ' +
          'it" is ' + num(ce.trigger, 1) + ' — this clears it by ' + num(ce.rebuild_gain - ce.trigger, 1) + ').</p>' +
          '<p style="margin:0 0 8px">It changes <b>' + nOut +
          ' of your 11 outfield-plus-keeper slots</b> (' + nOut + ' leaving, ' + nIn + ' arriving — see the ' +
          'Transfers panel below for exactly who).</p>' +
          '<p style="margin:0' + (genuinelyClosing ? '' : ';margin-bottom:0') +
          (genuinelyClosing ? ';color:var(--warn)' : '') + '"><b>' + esc(windowTxt) + '</b>' +
          (genuinelyClosing ? ' This is closing soon.' : ' There is no need to decide this on urgency.') + '</p>';
      } else {
        wcExplainEl.innerHTML = '';
        wcExplainEl.style.display = 'none';
      }
    }
    var noPrior = null;
    if (rec.appearance_sources) {
      var measured = Object.keys(rec.appearance_sources).length;
      noPrior = measured + ' appearance count(s) measured from history.';
    }
    $('week-chips-note').textContent = noPrior || '';

    // transfers, per pair then package
    //
    // OWNER-CAUGHT 2026-09-08 (second pass): a wildcard used to render
    // through this SAME arrow-table shape ("Out -> In" rows), grouped by
    // position and zipped by ARRAY INDEX within each group. That index
    // pairing is not real -- wildcard_out/wildcard_in are two
    // independent sets with no correspondence beyond sharing a
    // position (this file's own prior comment already said so) -- but
    // the rendered arrow still LOOKED like a paired swap, which is
    // exactly how a defender leaving at 6.05 xP and one arriving at
    // 2.35 xP read as an unexplained downgrade: it was never a swap,
    // it was two independent slots in an 11-player rebuild that nets
    // +27-35 points overall. Redesigned: a wildcard renders as two
    // plain lists (out / in), never an arrow, with the whole rebuild's
    // net gain stated once at the top -- matching what the data
    // actually is, not what a transfers table's shape implies.
    //
    // A REAL paired transfer (this branch, tin.length === tout.length)
    // keeps the arrow (the pairing IS real here) but now states the
    // REASON next to every row, per the instruction that a swap to a
    // lower-projected player with no stated cause is the most alarming
    // thing on the page. The reason is derived from fields already on
    // the record: a released free transfer, a chip/budget context, or
    // (the common real case) the swap raises the OBJECTIVE even though
    // the single-gameweek xP looks lower -- e.g. freeing budget for a
    // later upgrade elsewhere in the same package, which a per-player
    // xP comparison alone cannot show.
    var tbody = $('week-transfers-body');
    var tout = rec.transfers_out || [];
    if (tin.length && tin.length === tout.length) {
      var rows = '';
      for (var i = 0; i < tin.length; i++) {
        var outId = tout[i], inId = tin[i];
        var outName = (meta[outId] && meta[outId].name) || ('#' + outId);
        var inName = (meta[inId] && meta[inId].name) || ('#' + inId);
        var outXp = xf[outId] != null ? (Array.isArray(xf[outId]) ? xf[outId][0] : xf[outId]) : null;
        var inXp = xf[inId] != null ? (Array.isArray(xf[inId]) ? xf[inId][0] : xf[inId]) : null;
        var reasonTxt;
        if (outXp != null && inXp != null && inXp < outXp) {
          // A swap to a lower NEXT-gameweek projection is only ever
          // correct because the package objective (5-gameweek weighted
          // total, captain doubled, minus hits) is higher than keeping
          // the outgoing player -- stated explicitly rather than left
          // for a reader to infer from a single-gameweek number that
          // looks like a downgrade in isolation.
          reasonTxt = 'projects lower next gameweek (' + num(inXp, 2) + ' vs ' +
            num(outXp, 2) + ') but raises the ' + objectiveLabel(rec.objective_mode) +
            ' — the package is judged on that total, not one player’s single-gameweek number';
        } else if (outXp != null && inXp != null) {
          reasonTxt = 'projects higher next gameweek (' + num(inXp, 2) + ' vs ' + num(outXp, 2) + ')';
        } else {
          reasonTxt = 'no projection available for one side of this swap';
        }
        rows += '<tr><td><b>' + esc(outName) + ' → ' + esc(inName) + '</b>' +
          '<div class="decomp" style="white-space:normal;margin-top:2px">' + esc(reasonTxt) + '</div></td>' +
          '<td class="num">' + (outXp != null && inXp != null ? num(inXp - outXp, 2) : '—') + '</td>' +
          '<td class="num">—</td><td>—</td></tr>';
      }
      rows += '<tr><td class="dim">Package</td><td class="num" title="' +
        esc(objectiveLabel(rec.objective_mode)) + '">' +
        (rec.objective_xp != null ? num(rec.objective_xp, 1) : '—') + '</td>' +
        '<td class="num">' + (rec.hits ? '<span class="pill crit">' + rec.hits + ' hit(s)</span>' :
          '<span class="pill good">free</span>') + '</td><td>—</td></tr>';
      tbody.innerHTML = rows;
    } else if (wcOut.length || wcIn.length) {
      var POS_ORDER2 = ['GKP', 'DEF', 'MID', 'FWD'];
      var byPosOut = { GKP: [], DEF: [], MID: [], FWD: [] };
      var byPosIn = { GKP: [], DEF: [], MID: [], FWD: [] };
      wcOut.forEach(function (id) {
        var pos = (meta[id] && meta[id].position) || 'FWD';
        (byPosOut[pos] || byPosOut.FWD).push(id);
      });
      wcIn.forEach(function (id) {
        var pos = (meta[id] && meta[id].position) || 'FWD';
        (byPosIn[pos] || byPosIn.FWD).push(id);
      });
      var wcHeaderNote = '<tr><td colspan="4" style="border-bottom:0;padding-bottom:2px">' +
        '<div class="callout" style="margin:0 0 10px">A wildcard replaces the whole squad — these are ' +
        (wcOut.length) + ' players leaving and ' + (wcIn.length) + ' arriving, grouped by ' +
        'position for readability. <b>They are not one-for-one swaps</b> — no player leaving ' +
        'corresponds to any specific player arriving. The rebuild as a whole projects ' +
        (rec.objective_xp != null ? num(rec.objective_xp, 1) : '—') + ' ' +
        esc(objectiveLabel(rec.objective_mode)) + '.</div></td></tr>';
      var wcRows = wcHeaderNote;
      POS_ORDER2.forEach(function (pos) {
        var outs = byPosOut[pos], ins = byPosIn[pos];
        if (!outs.length && !ins.length) return;
        var outCells = outs.map(function (id) {
          var xp = xf[id] != null ? (Array.isArray(xf[id]) ? xf[id][0] : xf[id]) : null;
          return esc((meta[id] && meta[id].name) || '#' + id) + (xp != null ? ' (' + num(xp, 2) + ')' : '');
        }).join(', ') || '—';
        var inCells = ins.map(function (id) {
          var xp = xf[id] != null ? (Array.isArray(xf[id]) ? xf[id][0] : xf[id]) : null;
          return esc((meta[id] && meta[id].name) || '#' + id) + (xp != null ? ' (' + num(xp, 2) + ')' : '');
        }).join(', ') || '—';
        wcRows += '<tr><td><span class="pill">' + esc(pos) + '</span></td>' +
          '<td colspan="3"><b>Leaving:</b> ' + outCells + '<br><b>Arriving:</b> ' + inCells + '</td></tr>';
      });
      tbody.innerHTML = wcRows;
    } else {
      tbody.innerHTML = '<tr><td colspan="4" style="color:var(--ink-3)">No transfers on this record.</td></tr>';
    }

    // captain basis -- DELIVERED (owner-directed 2026-09-08, item 6):
    // this panel used to promise "a full breakdown (current form,
    // fixture difficulty, betting odds) is not shown yet" while
    // field.json already carried exactly that breakdown for every
    // scored player, captain included. Rendered here from data already
    // on the page (fieldById, built above) -- nothing new fetched or
    // computed server-side, matching this file's own governing rule.
    var basisEl = $('week-captain-basis');
    if (rec.captain != null && xf[String(rec.captain)] != null) {
      var capXp = Array.isArray(xf[String(rec.captain)]) ? xf[String(rec.captain)][0] : xf[String(rec.captain)];
      var capName = (meta[rec.captain] && meta[rec.captain].name) || ('#' + rec.captain);
      var capField = fieldById[rec.captain];
      basisEl.innerHTML = decompositionHtml(capName, capXp, capField, true);
    } else {
      basisEl.textContent = 'No captain on this record.';
    }
    var calloutEl = $('week-captain-callout');
    if (owner && ce.captain_xp != null && ce.trigger != null && ce.captain_xp < ce.trigger) {
      calloutEl.style.display = '';
      calloutEl.textContent = 'Evaluator did not recommend this chip (' +
        num(ce.captain_xp, 2) + ' vs bar ' + num(ce.trigger, 1) + '). Owner override.';
    } else {
      calloutEl.style.display = 'none';
    }

    // contested slots: for every player this record's transfers/wildcard
    // changed, the top alternatives at a comparable price and the margin
    // by which the chosen player won. field.players already carries a
    // full per-player decomposition (execution/build_site.py's
    // build_field()) for every player the estimator scored, not only
    // squad members -- so alternatives are read from data already on
    // the page, nothing new fetched or computed server-side. field.json
    // is DOCUMENTED to be legitimately empty on a record predating it
    // (see the player_index comment above) -- degrades to a plain note,
    // not a crash or a silently-empty panel.
    var contestedEl = $('week-contested');
    if (contestedEl) {
      var fPlayers = (field && field.players) || [];
      // wcIn/tin have NO real pairing to a specific outgoing player at
      // matching array index -- the transfers table above pairs
      // tin[i]/tout[i] because THOSE are genuinely 1:1, but a wildcard's
      // wcOut/wcIn are two independent sets (grouped by POSITION only,
      // never index-paired) with no "this out became that in" fact to
      // report. An earlier version of this code zipped them by index
      // regardless and produced nonsense pairs (a departing defender
      // captioned as if he'd "become" an incoming goalkeeper) -- fixed
      // by never implying a pairing that is not in the underlying wcOut/
      // wcIn data (which is deliberately unordered relative to
      // wcIn[i]/wcOut[i]; only same-position membership is meaningful).
      var isWildcard = wcOut.length > 0 || wcIn.length > 0;
      var inIds = isWildcard ? wcIn : tin;
      if (!fPlayers.length) {
        contestedEl.innerHTML = '<p style="margin:0;color:var(--ink-3);font-size:13px">' +
          'No decomposition on this record yet (field.json is empty until ' +
          'xp_decomposition exists for it) -- alternatives cannot be shown.</p>';
      } else if (!inIds.length) {
        contestedEl.innerHTML = '<p style="margin:0;color:var(--ink-3);font-size:13px">' +
          'No transfers on this record -- nothing contested.</p>';
      } else {
        var byId = {};
        fPlayers.forEach(function (p) { byId[p.id] = p; });
        var PRICE_BAND = 1.0; // +/- £1.0m, "comparable price"
        var html = '';
        for (var ci = 0; ci < inIds.length; ci++) {
          var chosenId = inIds[ci];
          var chosen = byId[chosenId];
          if (!chosen) continue;
          var pos = chosen.position;
          // Only a PAIRED transfer (tin/tout, genuinely 1:1) gets an
          // "out -> in" caption. A wildcard slot is captioned as a plain
          // pick -- there is no single player it "replaced".
          var outName = null;
          if (!isWildcard) {
            var pairIdx = tin.indexOf(chosenId);
            var outId = pairIdx !== -1 ? tout[pairIdx] : null;
            outName = outId != null ? ((byId[outId] && byId[outId].name) ||
              (meta[outId] && meta[outId].name) || '#' + outId) : null;
          }
          var lo = chosen.price - PRICE_BAND, hi = chosen.price + PRICE_BAND;
          var rivals = fPlayers.filter(function (p) {
            return p.position === pos && p.id !== chosenId &&
              p.price >= lo && p.price <= hi && !p.in_squad;
          }).sort(function (a, b) { return (b.final_h1 || 0) - (a.final_h1 || 0); })
            .slice(0, 5);
          html += '<div style="margin-bottom:16px">' +
            '<div style="font:600 13px/1.4 var(--sans,inherit);margin-bottom:6px">' +
            '<span class="pill acc">' + esc(pos) + '</span> ' +
            (outName ? esc(outName) + ' → ' : '') + '<b>' + esc(chosen.name) + '</b>' +
            ' <span style="color:var(--ink-3);font-weight:400">' +
            '£' + num(chosen.price, 1) + 'm · ' + num(chosen.final_h1, 2) + ' projected points, next gameweek</span></div>' +
            '<div style="margin:0 0 10px;font-size:12.5px">' + decompositionHtml(chosen.name, chosen.final_h1, chosen, false, true) + '</div>';
          if (!rivals.length) {
            html += '<p style="margin:0 0 0 8px;color:var(--ink-3);font-size:12.5px">' +
              'No other ' + esc(pos) + ' within £' + PRICE_BAND.toFixed(1) +
              'm found (outside the current squad) to compare against.</p>';
          } else {
            html += '<table style="width:100%;font-size:12.5px"><thead><tr>' +
              '<th style="text-align:left">Other option</th><th class="num">Price</th>' +
              '<th class="num">Projected points</th><th class="num">How much better the pick is</th></tr></thead><tbody>';
            rivals.forEach(function (r) {
              var margin = chosen.final_h1 - r.final_h1;
              html += '<tr><td>' + esc(r.name) + ' (' + esc(r.team || '') + ')</td>' +
                '<td class="num">£' + num(r.price, 1) + 'm</td>' +
                '<td class="num">' + num(r.final_h1, 2) + '</td>' +
                '<td class="num">' + (margin >= 0 ? '+' : '') + num(margin, 2) + '</td></tr>';
            });
            html += '</tbody></table>';
          }
          html += '</div>';
        }
        contestedEl.innerHTML = html || '<p style="margin:0;color:var(--ink-3);font-size:13px">' +
          'No comparable alternatives found for any changed slot.</p>';
      }
    }

    wireActionPanel(rec);
  }

  // -------------------------------------------------------------------
  // ACTION PANEL (Phase 3) — POST /action on the Cloudflare Worker.
  //
  // This is the one place in app.js that writes rather than only reads,
  // per the Worker being the ONLY thing this file is allowed to reach
  // live (see the file's own governing-rule comment at the top) --
  // Phase 3 is precisely when that becomes true.
  //
  // AUTH: a shared secret (OWNER_ACTION_TOKEN, a Worker secret), sent as
  // Authorization: Bearer <token> -- see directives/console_deploy.md for
  // why (no Cloudflare Access application exists; no Cloudflare project
  // exists at all). The Settings control below saves the token to
  // localStorage; the panel stays disabled until one is present. The
  // Worker's dormant Cloudflare Access path (if CF_ACCESS_TEAM_DOMAIN is
  // ever set server-side) needs no change here -- this code only ever
  // sends Authorization, and the Worker decides which check that header
  // is compared against.
  // -------------------------------------------------------------------
  function wireActionPanel(rec) {
    var gw = rec.gw;
    var textarea = document.querySelector('.action textarea');
    var buttons = document.querySelectorAll('.action .row2 .btn');
    if (!textarea || !buttons.length) return; // markup not present on this page load
    var intentBtn = buttons[0], approveBtn = buttons[1], rejectBtn = buttons[2], excludeBtn = buttons[3];
    var noteEl = $('week-action-note');
    var statusEl = $('week-action-status');
    var tokenInput = $('week-action-token-input');
    var tokenSaveBtn = $('week-action-token-save');
    var tokenClearBtn = $('week-action-token-clear');

    function setStatus(msg, isError) {
      if (!statusEl) return;
      statusEl.textContent = msg;
      statusEl.style.color = isError ? 'var(--crit, #c0392b)' : 'var(--ink-3)';
    }

    function refreshTokenGate() {
      var token = getActionToken();
      var hasToken = !!token;
      if (tokenInput && !tokenInput.matches(':focus')) tokenInput.value = hasToken ? token : '';
      if (!ACTION_WORKER_URL) {
        [intentBtn, approveBtn, rejectBtn, excludeBtn].forEach(function (b) {
          b.disabled = true;
          b.title = 'These buttons are not switched on for this console yet.';
        });
        return;
      }
      if (!hasToken) {
        [intentBtn, approveBtn, rejectBtn, excludeBtn].forEach(function (b) {
          b.disabled = true;
          b.title = 'Save your access code above first.';
        });
        return;
      }

      // Worker configured AND a token is saved -- clear the static
      // "not switched on" placeholder title, each button gets its own
      // real title below.
      [intentBtn, approveBtn, rejectBtn, excludeBtn].forEach(function (b) {
        b.title = '';
      });
      if (noteEl) {
        noteEl.innerHTML = 'What you type here is saved. Nothing is ever submitted to the FPL app for you — ' +
          'decisions are still entered by you, directly.';
      }

      var ownerBlock = rec.owner || {};
      var intentAlreadySet = !!(ownerBlock.intent && ownerBlock.intent.value);
      intentBtn.disabled = intentAlreadySet;
      intentBtn.title = intentAlreadySet
        ? 'Already saved for this gameweek and cannot be changed: ' +
          (formatTime(ownerBlock.intent.timestamp) || ownerBlock.intent.timestamp || '')
        : 'Saved before you can see the system\'s own recommendation, so the comparison is honest.';
      if (intentAlreadySet) {
        textarea.disabled = true;
        textarea.value = ownerBlock.intent.value;
      }
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
      excludeBtn.disabled = false;
    }

    if (tokenSaveBtn) {
      tokenSaveBtn.onclick = function () {
        var v = (tokenInput && tokenInput.value || '').trim();
        if (!v) { setStatus('Paste a token first.', true); return; }
        if (setActionToken(v)) {
          setStatus('Token saved to this browser.', false);
        } else {
          setStatus('Could not save the token (localStorage unavailable in this browser/mode).', true);
        }
        refreshTokenGate();
      };
    }
    if (tokenClearBtn) {
      tokenClearBtn.onclick = function () {
        setActionToken('');
        if (tokenInput) tokenInput.value = '';
        setStatus('Token cleared.', false);
        refreshTokenGate();
      };
    }

    refreshTokenGate();

    function postAction(kind, payload, btn) {
      var token = getActionToken();
      if (!token) {
        setStatus('No access code saved — open Settings above.', true);
        return Promise.reject(new Error('no token'));
      }
      var originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Sending…';
      setStatus('Sending ' + kind + ' for gameweek ' + gw + '…', false);
      return fetch(ACTION_WORKER_URL + '/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ gw: gw, kind: kind, payload: payload }),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
          return body;
        });
      }).then(function (body) {
        setStatus(kind + ' recorded for gameweek ' + gw + '.', false);
        return body;
      }).catch(function (e) {
        setStatus(kind + ' FAILED: ' + e.message, true);
        throw e;
      }).finally(function () {
        btn.disabled = false;
        btn.textContent = originalText;
      });
    }

    intentBtn.onclick = function () {
      var text = (textarea.value || '').trim();
      if (!text) { setStatus('Write what you intend to do first.', true); return; }
      postAction('intent', { intent: text }, intentBtn).then(function () {
        intentBtn.disabled = true;
        textarea.disabled = true;
      }).catch(function () {});
    };
    approveBtn.onclick = function () {
      postAction('approve', {}, approveBtn).catch(function () {});
    };
    rejectBtn.onclick = function () {
      postAction('reject', {}, rejectBtn).catch(function () {});
    };
    excludeBtn.onclick = function () {
      var chip = window.prompt('Which chip should be ruled out this week? (Wildcard, Free Hit, Bench Boost, or Triple Captain):');
      if (!chip) return;
      postAction('exclude_chip', { chip: chip.trim() }, excludeBtn).catch(function () {});
    };
  }

  // DECOMPOSITION RENDERER (owner-directed 2026-09-08, item 6): renders
  // field.json's real per-player breakdown -- current form (ep_next,
  // the FPL API's own next-gameweek expectation, blended with last
  // season's rate where minutes are thin), fixture difficulty
  // (fixture_factor_total -- a multiplier, 1.00 is neutral, above is
  // easier, below is harder), and betting odds (odds_term_raw, a
  // separate market-derived adjustment blended in before the final
  // number). Used by both the captain basis and the contested-slots
  // panel so "why is this player in" reads the same way everywhere on
  // the page. Deliberately NOT presented as a strict sum (fixture and
  // odds are multiplicative/blended adjustments to form, not additive
  // terms) -- an honest decomposition says what kind of adjustment each
  // piece is, rather than implying arithmetic that would not actually
  // reconstruct the final number.
  function decompositionHtml(name, finalXp, fieldRow, isCaptain, skipLead) {
    var lead = (isCaptain ? 'Captain ' : '') + esc(name) + ' — projected <b>' +
      num(finalXp, 2) + ' points</b>, next gameweek' +
      (isCaptain ? ', before the captain\'s points are doubled' : '') + '.';
    if (!fieldRow) {
      return (skipLead ? '' : '<p style="margin:0">' + lead + '</p>') +
        '<p style="margin:6px 0 0;color:var(--ink-3);font-size:12.5px">' +
        'No decomposition on this record yet (field.json has no row for this player).</p>';
    }
    var rows = [];
    if (fieldRow.ep_next != null) {
      rows.push(['Current form', num(fieldRow.ep_next, 2) + ' pts',
        'the FPL app\'s own projection for this player next gameweek, blended with last season\'s rate if he has played few minutes this season']);
    }
    if (fieldRow.fixture_factor_total != null) {
      var ff = fieldRow.fixture_factor_total;
      var ffWord = ff > 1.05 ? 'easier than average' : ff < 0.95 ? 'harder than average' : 'about average difficulty';
      rows.push(['Fixture difficulty', '×' + num(ff, 2), 'this gameweek\'s fixture is ' + ffWord + ' (1.00 would be exactly average)']);
    }
    if (fieldRow.odds_term_raw != null) {
      rows.push(['Betting-market adjustment', num(fieldRow.odds_term_raw, 2) + ' pts',
        'a separate estimate blended in from bookmaker odds on this match, not simply added to the figures above']);
    }
    var rowsHtml = rows.map(function (r) {
      return '<tr><td style="padding:3px 10px 3px 0;color:var(--ink-3)">' + esc(r[0]) + '</td>' +
        '<td style="padding:3px 10px 3px 0;font-family:var(--mono);white-space:nowrap">' + esc(r[1]) + '</td>' +
        '<td style="padding:3px 0;color:var(--ink-3);font-size:12.5px">' + esc(r[2]) + '</td></tr>';
    }).join('');
    return (skipLead ? '' : '<p style="margin:0 0 8px">' + lead + '</p>') +
      '<table style="width:100%"><tbody>' + rowsHtml + '</tbody></table>' +
      '<p style="margin:8px 0 0;font-size:11.5px;color:var(--ink-3)">These combine (form adjusted by fixture, then blended with the betting-odds estimate) to the final projected points above — not a simple sum of the rows.</p>';
  }

  function chipRow(name, sub, value, trigger, pillText, caveat) {
    var pct = trigger ? Math.max(0, Math.min(100, (value / trigger) * 100)) : 0;
    var pill = pillText
      ? '<span class="pill ' + (pillText === 'OWNER' ? 'owner' :
          pillText === 'EXCLUDED' ? 'warn' : 'acc') + '">' + esc(pillText) + '</span>'
      : '';
    // OWNER-CAUGHT 2026-09-07: the wildcard baseline compares against a
    // single-shot, static-squad projection (base_h holds the same
    // squad across all 5 weighted weeks) rather than a manager
    // accruing and using a fresh free transfer each gameweek across
    // the horizon -- confirmed by reading optimise() directly, see
    // directives/prereg_wildcard_baseline_review.md. The gain shown
    // here therefore overstates the case for the chip against the
    // baseline a real manager without it would actually reach. The
    // baseline itself is checkpointed and not changed here -- this
    // states the caveat AT the number it qualifies, inside the same
    // chip block, so it cannot render as a clean, unqualified
    // recommendation while the record itself knows the measurement is
    // biased in the chip's favour.
    var caveatHtml = caveat
      ? '<div class="callout warn" style="margin-top:6px;font-size:11.5px;padding:6px 8px">' +
        esc(caveat) + '</div>'
      : '';
    return '<div class="chip"><div class="name">' + esc(name) + '<small>' + esc(sub) +
      '</small></div><div class="bar"><i style="width:' + pct.toFixed(0) + '%"></i>' +
      '<span class="mark" style="left:100%"></span></div><div class="n">' +
      num(value, 2) + ' pts (bar to clear: ' + num(trigger, 1) + ')' + (pill ? ' · ' + pill : '') + '</div>' +
      caveatHtml + '</div>';
  }

  // -------------------------------------------------------------------
  // HISTORY
  // -------------------------------------------------------------------
  function renderHistory(history) {
    var entries = history.entries || [];
    var tl = $('history-tl');
    if (!entries.length) {
      $('history-sub').textContent = 'No decision records found.';
      tl.innerHTML = '';
      return;
    }
    $('history-sub').textContent = entries.length + ' record(s) scanned.';
    var html = '';
    entries.slice().reverse().forEach(function (e) {
      var statusPill = e.decision_status === 'api_observed'
        ? ' <span class="pill owner">API-CONFIRMED</span>'
        : e.decision_status === 'owner_reported'
        ? ' <span class="pill acc">OWNER-REPORTED</span>'
        : (e.is_owner_decision ? ' <span class="pill owner">OWNER</span>' : '');
      html += '<div class="t">' + esc(e.written || e.record) + '</div><div class="e">' +
        '<b>GW' + esc(e.gw) + (e.chip ? ' · ' + esc(e.chip) : '') + '</b>' +
        statusPill +
        '<div class="d">captain #' + esc(e.captain) +
        (e.captain_xp != null ? ' (' + num(e.captain_xp, 2) + ')' : '') +
        (e.hits ? ' · ' + e.hits + ' hit(s)' : '') +
        (e.objective_xp != null ? ' · ' + num(e.objective_xp, 1) + ' '
          + objectiveLabel(e.objective_mode) : '') +
        '</div></div>';
    });
    tl.innerHTML = html;

    var withDiff = entries.slice().reverse().find(function (e) {
      return e.diff_from_previous && Object.keys(e.diff_from_previous).length;
    });
    var body = $('history-diff-body');
    if (withDiff) {
      $('history-diff-h2').textContent = 'Diff · into ' + (withDiff.written || withDiff.record);
      var rows = '';
      Object.keys(withDiff.diff_from_previous).forEach(function (f) {
        var d = withDiff.diff_from_previous[f];
        rows += '<tr><td>' + esc(f) + '</td><td class="num">' + esc(d.before) +
          '</td><td class="num">' + esc(d.after) + '</td></tr>';
      });
      body.innerHTML = rows;
    } else {
      body.innerHTML = '<tr><td colspan="3" style="color:var(--ink-3)">No same-gameweek diff available.</td></tr>';
    }
  }

  // -------------------------------------------------------------------
  // HEALTH
  // -------------------------------------------------------------------
  function renderHealth(health) {
    // OWNER-CAUGHT 2026-09-07: the bare word "unknown" next to a note
    // like "CI minted a fresh session 2026-09-07T16:24:34Z" reads as a
    // contradiction -- a fresh mint 90 minutes before the build sounds
    // like a real, recent, successful event, not "we don't know". The
    // real fact is narrower: MINTING a session is not the same as
    // CHECKING it against IdP/FPL live, and this branch is reached
    // exactly when no live check ran (no bearer token available to this
    // build step at all -- true for every normal CI build). Say that
    // plainly, and surface the actual most-recent event from the note
    // instead of a bare status word that implies nothing is known.
    var sess = health.session || {};
    var sBig = $('health-session-big');
    if (sess.idp_status === 200 && sess.fpl_status === 200) {
      sBig.innerHTML = '<i class="dot good"></i>alive';
    } else if (sess.idp_status || sess.fpl_status) {
      sBig.innerHTML = '<i class="dot crit"></i>degraded';
    } else {
      sBig.innerHTML = '<i class="dot warn"></i>not checked this build';
    }
    $('health-session-note').textContent =
      'Login service status ' + esc(sess.idp_status || '—') + ' · FPL site status ' + esc(sess.fpl_status || '—') +
      (sess.access_token_exp ? ' · logged-in session valid until ' + esc(formatTime(sess.access_token_exp) || sess.access_token_exp) : '') +
      (sess.note
        ? ' · ' + esc(reformatEmbeddedTimestamps(sess.note)) +
          (!sess.idp_status && !sess.fpl_status
            ? ' (creating a fresh login is not the same as testing it works -- '
              + 'this is the last thing that happened, not a live result)'
            : '')
        : '');

    var sched = health.scheduler || {};
    $('health-scheduler-big').textContent = sched.delivery_pct != null
      ? sched.delivery_pct + '%' : '—';
    $('health-scheduler-note').textContent = sched.note ||
      (sched.runs_created != null ? sched.runs_created + ' of ~' + sched.runs_expected + ' expected' : '—');

    var fr = health.freeze || {};
    $('health-freeze-big').innerHTML = fr.stamped
      ? '<i class="dot good"></i>stamped' : '<i class="dot warn"></i>unstamped';
    $('health-freeze-note').textContent = fr.n_files != null
      ? fr.n_files + ' semantics file(s) match' : '—';

    // Informational, not a fault -- drift against the GW1 baseline is the
    // expected, legitimate result of the 2026-09-08 checkpoint governance
    // working, so this tile is never painted warn/bad the way freeze's is.
    var sd = health.strategy_drift || {};
    $('health-strategy-drift-big').textContent = sd.status === 'ok'
      ? sd.n_differences + ' of ' + sd.n_values_compared : '—';
    $('health-strategy-drift-note').textContent = sd.status === 'ok'
      ? (sd.n_differences
          ? sd.differences.map(function (d) {
              return esc(d.key) + ' (' + esc(String(d.gw1)) + ' → ' + esc(String(d.live)) + ')';
            }).join(', ')
          : 'no values differ from the GW1 baseline')
      : (sd.note || '—');

    var flagsEl = $('health-flags');
    var flags = health.chronic_flags || [];
    if (flags.length) {
      flagsEl.innerHTML = flags.map(function (f) {
        // THIRD STATE (owner-caught 2026-09-06): a flag can carry an
        // explicit `state` ("firing"/"clear"/"unknown") when a genuine
        // "could not tell" case exists (e.g. ci_tests_failing with no
        // token, network error). Falls back to the old firing-bool-only
        // binary for flags that never have that case. "unknown" gets its
        // OWN visually distinct square/pill -- never painted the same
        // red as a confirmed failure, which is the exact collapse this
        // fix closes.
        var state = f.state || (f.firing ? 'firing' : 'clear');
        // OWNER-CAUGHT 2026-09-08: any state string OTHER than 'firing'/
        // 'unknown' fell through to 'good' (green) here, while the nav
        // badge's needsAttention count (above, in this same file) treats
        // anything !== 'clear' as needing attention. scale_gate's new
        // 'stale_pre_respec' state (a record predating the current gate --
        // nothing was actually verified) rendered a GREEN square while
        // still counting toward "N flags" and blocking the OK verdict --
        // the badge said a problem existed, the square said none did. A
        // state that is not a genuinely-verified 'clear' must never paint
        // green, regardless of which specific non-clear string it is --
        // checked with `!== 'clear'` (matching needsAttention's own logic
        // exactly) rather than enumerating every non-clear state by name,
        // so a FUTURE new state can never reintroduce this by omission.
        // OWNER-CAUGHT 2026-09-08 (second pass): 'info' (floored_negative,
        // retired as a gating condition, kept as a real reported number)
        // must NOT paint the same amber/warn as a genuine "cannot verify"
        // or "unusual" state -- it never blocks approval, so painting it
        // like something that might is the same false-alarm shape this
        // whole flag system exists to avoid, just inverted (a non-
        // gating fact dressed as a caution rather than a gating fact
        // dressed as fine). Given its own distinct colour (accent/'acc',
        // already used elsewhere on this page for neutral, non-alarm
        // UI), checked explicitly before the generic non-clear catch-all.
        var sq = state === 'firing' ? 'crit'
          : state === 'info' ? 'acc'
          : state !== 'clear' ? 'warn' : 'good';
        var pillClass = state === 'firing' ? 'warn'
          : state === 'info' ? 'acc'
          : state !== 'clear' ? 'warn' : 'good';
        // OWNER-CAUGHT 2026-09-07: state alone ("clear") is unverifiable
        // -- a reader has no way to tell a near-miss (1.8375 against a
        // 2.0 line) from nowhere-near-the-line. `threshold` states the
        // actual reading against the actual firing line, so 'clear' can
        // be checked, not just trusted.
        var thresholdHtml = f.threshold != null
          ? '<small class="threshold">' + esc(f.threshold) + '</small>' : '';
        // OWNER-CAUGHT 2026-09-07 (failure-swallow sweep): ci_tests_failing
        // carries a real run_url (the failing run a reader needs to open)
        // that was computed server-side and never rendered anywhere.
        var linkHtml = f.link
          ? '<small><a href="' + esc(f.link) + '" target="_blank" rel="noopener">view run</a></small>'
          : '';
        // PILL WORDING (owner-directed 2026-09-08 jargon sweep): the raw
        // state token ('firing'/'clear'/'info'/'unknown') is an internal
        // name, not a word a reader parses at a glance -- shown in plain
        // English, with the token itself kept in the title attribute for
        // anyone cross-referencing this against a record file directly.
        var stateWord = state === 'firing' ? 'needs attention'
          : state === 'info' ? 'informational'
          : state === 'unknown' ? 'could not check'
          : 'OK';
        return '<div class="flag"><span class="sq ' + sq + '"></span><div><b>' +
          esc(f.label) + '</b><small>' + esc(f.value != null ? f.value : '') + '</small>' +
          thresholdHtml + linkHtml + '</div>' +
          '<span class="pill ' + pillClass + '" title="internal state: ' + esc(state) + '">' + esc(stateWord) + '</span></div>';
      }).join('');
    } else {
      flagsEl.innerHTML = '<p style="color:var(--ink-3);margin:0">No history to check yet on the latest record.</p>';
    }

    // OWNER-CAUGHT 2026-09-08: this panel and the estimator_unvalidated
    // chronic flag (above) stated TWO DIFFERENT clearing rules for what
    // reads as the same fact -- this panel said "clears after 3 clean
    // gameweeks", the flag's own threshold says "fires if the estimator
    // changed after the last settled gameweek's deadline". They are
    // different questions: xp_model.estimator_unvalidated() (what the
    // FLAG actually checks) is a ONE-condition test with no gameweek
    // counting at all -- it clears the moment ANY gameweek settles after
    // the last estimator change, full stop. "3 clean gameweeks" is the
    // AUTONOMY criterion (directives/prereg_autonomy_criterion.md) --
    // a separate, stricter, multi-gameweek policy that uses this flag as
    // its floor but is not the same rule (see that file's own "the flag
    // alone is weaker than criterion (a)" section). Stating the 3-week
    // figure next to the flag's own 1-condition data implied they were
    // the same clearing rule. Split into two explicitly labelled facts.
    var est = health.estimator || {};
    $('health-estimator').textContent = est.changed_at
      ? ('The scoring model was last changed ' + (formatTime(est.changed_at) || est.changed_at) +
          (est.last_settled_gw != null
            ? '; the last completed gameweek was gameweek ' + est.last_settled_gw : '') +
          '. This check passes again as soon as one full gameweek has been played and scored ' +
          'since that change — it does not require several clean gameweeks in a row. Letting the ' +
          'system act on its own is a separate, stricter requirement (3 clean gameweeks in a row) ' +
          'and is not decided by this check alone.')
      : 'No record yet of when the scoring model last changed.';
  }

  // -------------------------------------------------------------------
  // FIELD
  // -------------------------------------------------------------------
  function renderField(field) {
    var players = field.players || [];
    $('nav-count-field').textContent = players.length || '–';
    var noteEl = $('field-note');
    if (!players.length) {
      $('field-sub').textContent = (field.source && field.source.note) ||
        'field.json has no players yet.';
      $('field-body').innerHTML = '';
      $('field-pills').innerHTML = '';
      return;
    }
    var srcRec = (field.source && field.source.record) || 'unknown record';
    var srcW = (field.source && field.source.record_written) || '';
    $('field-sub').textContent = players.length + ' players, from ' + srcRec +
      (srcW ? ' (' + srcW + ')' : '') +
      '. Every number from the stored record, never recomputed on the page.';

    var pillsEl = $('field-pills');
    var flagCounts = field.flag_counts || {};
    var pillHtml = '<span class="pill acc">' + esc(srcW || srcRec) + '</span>';
    Object.keys(flagCounts).forEach(function (label) {
      pillHtml += '<span class="pill warn">' + esc(label) + ' ' + flagCounts[label] + '</span>';
    });
    pillsEl.innerHTML = pillHtml;

    // Internal source token -> a name a reader recognises (owner-directed
    // 2026-09-08 jargon sweep).
    var PRIOR_SOURCE_LABEL = { last_season: "last season's rate", price: "price-based estimate" };
    var rows = '';
    players.forEach(function (p, i) {
      var priorTxt = p.prior_source
        ? esc(PRIOR_SOURCE_LABEL[p.prior_source] || p.prior_source) + ': ' + num(p.prior_value, 2) +
          ' pts, weighted ' + num(p.prior_weight * 100, 0) + '%' +
          (p.prior_discount < 1 ? ', discounted to ' + num(p.prior_discount * 100, 0) + '% for thin minutes' : '')
        : 'not used — enough current-season data on its own';
      var oddsTxt = p.odds_term_raw != null ? num(p.odds_term_raw, 2) : '—';
      var badge = p.is_transfer_in ? ' <span class="pill acc">arriving this week</span>' :
        (p.in_squad ? ' <span class="pill">in your squad</span>' : '');
      var flagsHtml = (p.flags || []).map(function (f) {
        var cls = f.indexOf('below-zero') !== -1 ? 'crit' : 'warn';
        return '<span class="pill ' + cls + '">' + esc(f) + '</span>';
      }).join(' ');
      rows += '<tr><td class="num">' + (i + 1) + '</td>' +
        '<td><b>' + esc(p.name) + '</b> ' + esc(p.team) + ' ' + esc(p.position) + badge + '</td>' +
        '<td class="num">' + num(p.price, 1) + '</td>' +
        '<td class="num">' + num(p.ep_next, 1) + '</td>' +
        '<td class="decomp" style="white-space:normal">' + priorTxt + '</td>' +
        '<td class="num">' + num(p.fixture_factor_total, 2) + '</td>' +
        '<td class="num">' + oddsTxt + '</td>' +
        '<td class="num"><b>' + num(p.final_h1, 2) + '</b></td>' +
        '<td>' + flagsHtml + '</td></tr>';
    });
    $('field-body').innerHTML = rows;
    noteEl.textContent = 'Sorted by next gameweek\'s projected points. The betting-odds ' +
      'column and its related flags only appear for records built after that data ' +
      'source was added — older records show neither.';
  }

  // -------------------------------------------------------------------
  // SEASON SUMMARY (status strip) — current.json's season_summary,
  // matching fantasy.premierleague.com's own Team overview page's
  // Points & Rankings / Transfers / Finance panels (owner-requested
  // 2026-09-12). None on any failure -- rendered as "unavailable", never
  // a fabricated number.
  // -------------------------------------------------------------------
  function renderSeasonSummary(current) {
    var s = (current || {}).season_summary;
    var el = $('season-summary');
    if (!s) {
      el.innerHTML = '<div class="panel stat"><span class="lbl">Season summary</span>' +
        '<span class="big">unavailable</span><span class="note">Could not reach the FPL entry endpoint on the last build.</span></div>';
      return;
    }
    function tile(lbl, big, small, note) {
      return '<div class="panel stat"><span class="lbl">' + esc(lbl) + '</span>' +
        '<span class="big">' + esc(big) + (small ? '<small>' + esc(small) + '</small>' : '') + '</span>' +
        (note ? '<span class="note">' + esc(note) + '</span>' : '') + '</div>';
    }
    el.innerHTML =
      tile('Overall points', s.overall_points != null ? s.overall_points : '—', null,
        'overall rank ' + (s.overall_rank != null ? Number(s.overall_rank).toLocaleString() : '—')) +
      tile('Gameweek ' + (s.gameweek != null ? s.gameweek : '—') + ' points', s.gameweek_points != null ? s.gameweek_points : '—', null,
        'GW rank ' + (s.gameweek_rank != null ? Number(s.gameweek_rank).toLocaleString() : '—')) +
      tile('Squad value', s.squad_value != null ? '£' + num(s.squad_value, 1) + 'm' : '—', null,
        'in the bank £' + (s.bank != null ? num(s.bank, 1) : '—') + 'm') +
      tile('Total transfers', s.total_transfers != null ? s.total_transfers : '—', null, 'made this season');
  }

  // -------------------------------------------------------------------
  // PLAYERS — real-world stats, injuries, Team of the Week (players.json,
  // owner-requested 2026-09-12). Deliberately separate from Field's own
  // model-projection table: this is already-happened stats straight from
  // bootstrap, no decision-record dependency.
  // -------------------------------------------------------------------
  var playersSortState = { key: 'total_points', dir: -1 };

  function playersSortRows(rows) {
    var key = playersSortState.key, dir = playersSortState.dir;
    return rows.slice().sort(function (a, b) {
      var av = a[key], bv = b[key];
      if (key === 'selected_by_percent' || key === 'form') { av = parseFloat(av) || 0; bv = parseFloat(bv) || 0; }
      if (typeof av === 'string' || typeof bv === 'string') {
        av = (av == null ? '' : String(av)).toLowerCase();
        bv = (bv == null ? '' : String(bv)).toLowerCase();
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      }
      return ((av == null ? -Infinity : av) - (bv == null ? -Infinity : bv)) * dir;
    });
  }

  function playersRenderTable(players) {
    var rows = playersSortRows(players);
    var html = '';
    rows.forEach(function (p) {
      var statusCls = p.status === 'a' ? '' : (p.status === 'i' || p.status === 's' || p.status === 'u' ? 'crit' : 'warn');
      html += '<tr><td><b>' + esc(p.name) + '</b>' + (p.in_dreamteam ? ' <span class="pill acc">TOTW</span>' : '') + '</td>' +
        '<td>' + esc(p.team) + '</td>' +
        '<td>' + esc(p.position) + '</td>' +
        '<td class="num">' + num(p.price, 1) + '</td>' +
        '<td class="num">' + esc(p.selected_by_percent) + '%</td>' +
        '<td class="num">' + esc(p.form) + '</td>' +
        '<td class="num">' + (p.gameweek_points != null ? p.gameweek_points : '—') + '</td>' +
        '<td class="num"><b>' + (p.total_points != null ? p.total_points : '—') + '</b></td>' +
        '<td>' + (statusCls ? '<span class="pill ' + statusCls + '">' + esc(p.status_label) + '</span>' : esc(p.status_label)) + '</td></tr>';
    });
    $('players-body').innerHTML = html || '<tr><td colspan="9" style="color:var(--ink-3)">No players.</td></tr>';
  }

  function renderPlayers(playersData) {
    var players = playersData.players || [];
    $('nav-count-players').textContent = players.length || '–';
    if (!players.length) {
      $('players-sub').textContent = (playersData.source && playersData.source.note) ||
        'players.json has no players yet.';
      $('players-body').innerHTML = '';
      $('players-unavail-body').innerHTML = '';
      $('players-tow-body').innerHTML = '';
      return;
    }
    $('players-sub').textContent = players.length + ' selectable players, straight from the FPL API\'s own bootstrap data.';

    playersRenderTable(players);

    // Sort-on-click, once — the table body re-renders from the same
    // players array on every click, nothing is recomputed except order.
    var table = $('players-table');
    if (table && !table._sortWired) {
      table._sortWired = true;
      table.querySelectorAll('th[data-sort]').forEach(function (th) {
        th.style.cursor = 'pointer';
        th.addEventListener('click', function () {
          var key = th.dataset.sort;
          if (playersSortState.key === key) playersSortState.dir *= -1;
          else { playersSortState.key = key; playersSortState.dir = (key === 'name' || key === 'team' || key === 'position' || key === 'status_label') ? 1 : -1; }
          playersRenderTable(players);
        });
      });
    }

    var unavail = playersData.unavailable || [];
    $('players-unavail-sub').textContent = unavail.length + ' player(s) not fully available, same as the real site\'s injury list.';
    var uHtml = '';
    unavail.forEach(function (p) {
      var cls = (p.status === 'i' || p.status === 's' || p.status === 'u') ? 'crit' : 'warn';
      uHtml += '<tr><td><b>' + esc(p.name) + '</b></td><td>' + esc(p.team) + '</td>' +
        '<td><span class="pill ' + cls + '">' + esc(p.status_label) + '</span>' +
        (p.chance_of_playing_next_round != null ? ' <span class="pill">' + p.chance_of_playing_next_round + '% chance</span>' : '') + '</td>' +
        '<td>' + esc(p.news || '—') + '</td></tr>';
    });
    $('players-unavail-body').innerHTML = uHtml || '<tr><td colspan="4" style="color:var(--ink-3)">Nobody flagged — everyone available.</td></tr>';

    var tow = playersData.team_of_the_week || [];
    var towHtml = '';
    tow.forEach(function (p) {
      towHtml += '<tr><td><b>' + esc(p.name) + '</b></td><td>' + esc(p.team) + '</td><td>' + esc(p.position) + '</td>' +
        '<td class="num">' + (p.gameweek_points != null ? p.gameweek_points : '—') + '</td></tr>';
    });
    $('players-tow-body').innerHTML = towHtml || '<tr><td colspan="4" style="color:var(--ink-3)">Not available yet.</td></tr>';
  }

  // -------------------------------------------------------------------
  // SCORECARD
  // -------------------------------------------------------------------
  function renderScorecard(scorecard) {
    var gws = scorecard.gameweeks || [];
    var decisions = scorecard.decisions || [];
    $('nav-count-score').textContent = gws.filter(function (g) { return g.settled; }).length || '–';

    if (!gws.length) {
      $('score-sub').textContent = (scorecard.source && scorecard.source.note) ||
        'scorecard.json has no gameweeks yet.';
      $('score-stats').innerHTML = '';
      $('score-decisions-body').innerHTML = '';
      $('score-gw-body').innerHTML = '';
      return;
    }

    var settled = gws.filter(function (g) { return g.settled; });
    var pending = gws.filter(function (g) { return !g.settled; });
    $('score-sub').textContent = 'Every grade is pre-registered before the football is played. ' +
      settled.length + ' gameweek(s) graded; ' + pending.length + ' pending settlement. ' +
      'One gameweek scores a decision, not the estimator.';

    // --- stat tiles: last settled XI, last settled captain, latest cohort ---
    var statsHtml = '';
    var lastSettled = settled[settled.length - 1];
    if (lastSettled && lastSettled.xi) {
      var xi = lastSettled.xi;
      var xiUp = xi.diff >= 0;
      statsHtml += '<div class="panel stat"><span class="lbl">Gameweek ' + lastSettled.gw +
        ' · starting eleven</span><span class="big">' + xi.actual + '<small>actual points</small></span>' +
        '<span class="note">projected ' + num(xi.projected, 1) + ' · <span class="delta ' +
        (xiUp ? 'up' : 'down') + '">' + (xiUp ? '+' : '') + num(xi.diff, 1) + '</span></span></div>';
    }
    if (lastSettled && lastSettled.captain) {
      var cap = lastSettled.captain;
      var capUp = cap.projected != null && (cap.actual - cap.projected) >= 0;
      statsHtml += '<div class="panel stat"><span class="lbl">Gameweek ' + lastSettled.gw +
        ' · captain ' + esc(cap.player) + '</span><span class="big">' + cap.actual +
        '<small>×' + cap.multiplier + ' = ' + cap.total + '</small></span>' +
        '<span class="note">projected ' + num(cap.projected, 2) + ' · <span class="delta ' +
        (capUp ? 'up' : 'down') + '">' + (capUp ? '+' : '') +
        num(cap.actual - cap.projected, 1) + '</span> before multiplying</span></div>';
    }
    var latestWithCohort = gws.slice().reverse().find(function (g) {
      return (g.cohorts || []).some(function (c) { return c.key === 'paired_tzolakis_becker'; });
    });
    if (latestWithCohort) {
      var pc = latestWithCohort.cohorts.find(function (c) { return c.key === 'paired_tzolakis_becker'; });
      statsHtml += '<div class="panel stat"><span class="lbl">Gameweek ' + latestWithCohort.gw +
        ' · head-to-head test</span><span class="big">' + esc(pc.status || '—') +
        '<small>Tzolakis vs Becker</small></span><span class="note">' + esc(pc.lines[0] || '') +
        '</span></div>';
    }
    $('score-stats').innerHTML = statsHtml;

    // --- decisions graded table ---
    var decRows = '';
    decisions.forEach(function (d) {
      var gradeStr = String(d.grade);
      // A per-pair transfer grade is a signed number ("+4"/"-3", from
      // gw_readout's structured `pairs` field) rather than one of the
      // cohort-level words below -- a negative one is a losing swap and
      // should read as a warning the same way "COST POINTS" does.
      var isNegativeNumber = /^-\d/.test(gradeStr);
      var gradeCls = /pending|—|unscorable/.test(gradeStr) ? '' :
        (/DID NOT|COST/.test(gradeStr) || isNegativeNumber) ? 'warn' : 'acc';
      decRows += '<tr><td class="num">' + esc(d.gw) + '</td>' +
        '<td>' + esc(d.decision) + (d.detail ? ' <div class="decomp">' + esc(d.detail) + '</div>' : '') + '</td>' +
        '<td class="num">' + (d.result != null ? esc(d.result) : 'pending') + '</td>' +
        '<td><span class="pill' + (gradeCls ? ' ' + gradeCls : '') + '">' + esc(d.grade || '—') + '</span></td></tr>';
    });
    $('score-decisions-body').innerHTML = decRows ||
      '<tr><td colspan="4" style="color:var(--ink-3)">No owner-facing decisions on the latest record.</td></tr>';

    // --- projected vs actual per gw, straight from readout_data ---
    var gwRows = '';
    gws.forEach(function (g) {
      if (!g.settled) {
        gwRows += '<tr><td class="num">GW' + g.gw + '</td><td class="num" colspan="3">' +
          esc(g.reason || 'not settled') + '</td></tr>';
        return;
      }
      if (!g.xi) {
        gwRows += '<tr><td class="num">GW' + g.gw + '</td><td class="num" colspan="3" style="color:var(--ink-3)">' +
          'settled, no proposed-XI record</td></tr>';
        return;
      }
      var up = g.xi.diff >= 0;
      gwRows += '<tr><td class="num">GW' + g.gw + '</td>' +
        '<td class="num">' + num(g.xi.projected, 1) + '</td>' +
        '<td class="num">' + g.xi.actual + '</td>' +
        '<td class="num"><span class="delta ' + (up ? 'up' : 'down') + '">' +
        (up ? '+' : '') + num(g.xi.diff, 1) + '</span></td></tr>';
    });
    $('score-gw-body').innerHTML = gwRows;
  }

  // -------------------------------------------------------------------
  // ODDS
  // -------------------------------------------------------------------
  function renderOdds(odds) {
    var teams = odds.teams || [];

    if (!teams.length) {
      $('odds-sub').textContent = (odds.source && odds.source.note) ||
        'odds.json has no teams yet.';
      $('odds-teams-body').innerHTML = '';
      $('odds-chip-windows').innerHTML = '';
      $('odds-dgw-bgw').innerHTML = '';
      $('odds-chip-usage').innerHTML = '';
      return;
    }

    var src = odds.source || {};
    $('odds-sub').textContent = 'Bookmaker win probability per club, rescaled to a factor ' +
      'around 1.0. From ' + esc(src.odds_archive || 'the odds archive') +
      (src.archived_gw != null ? ' (GW' + src.archived_gw + ')' : '') + '.';

    var rows = '';
    teams.slice().sort(function (a, b) {
      return (b.fixture_factor || 0) - (a.fixture_factor || 0);
    }).forEach(function (t) {
      var f = t.fixture_factor;
      var cls = f == null ? '' : f >= 1.1 ? 'up' : f <= 0.9 ? 'down' : '';
      rows += '<tr><td><b>' + esc(t.short_name) + '</b></td>' +
        '<td>' + (t.opponent ? esc(t.opponent) + (t.home ? ' (H)' : ' (A)') : '—') + '</td>' +
        '<td class="num">' + (t.p_win != null ? Math.round(t.p_win * 100) + '%' : '—') + '</td>' +
        '<td class="num"><span class="delta ' + cls + '">' + num(f, 3) + '</span></td></tr>';
    });
    $('odds-teams-body').innerHTML = rows;

    var chips = odds.chips || {};
    var windowsHtml = (chips.windows || []).map(function (w) {
      return '<div style="margin-bottom:4px"><b>' + esc(w.name) + '</b>: GW' +
        w.start_event + '–' + w.stop_event + '</div>';
    }).join('');
    $('odds-chip-windows').innerHTML = windowsHtml || '<p style="color:var(--ink-3)">No chip window data.</p>';

    var dgw = odds.dgw_bgw || {};
    var dgwHtml = '<p style="margin:0;font-size:13px;color:var(--ink-2)">';
    if (dgw.note) {
      dgwHtml += esc(dgw.note);
    } else {
      dgwHtml += 'GW' + dgw.next_gw + ': ';
      if (!(dgw.double || []).length && !(dgw.blank || []).length) {
        dgwHtml += 'no doubles or blanks — every team has exactly one fixture.';
      } else {
        if ((dgw.double || []).length) {
          dgwHtml += (dgw.double.length) + ' double(s): ' +
            dgw.double.map(function (d) { return esc(d.team); }).join(', ') + '. ';
        }
        if ((dgw.blank || []).length) {
          dgwHtml += (dgw.blank.length) + ' blank(s): ' +
            dgw.blank.map(function (d) { return esc(d.team); }).join(', ') + '.';
        }
      }
    }
    dgwHtml += '</p>';
    $('odds-dgw-bgw').innerHTML = dgwHtml;

    var usageGw = chips.field_wide_plays_gw;
    var usage = chips.field_wide_plays || [];
    if (usage.length) {
      $('odds-chip-usage').innerHTML = '<p style="margin:0 0 6px;font-size:12.5px;color:var(--ink-3)">GW' +
        usageGw + ', field-wide:</p>' + usage.map(function (u) {
        return '<div>' + esc(u.chip_name) + ': ' + u.num_played.toLocaleString() + '</div>';
      }).join('');
    } else {
      $('odds-chip-usage').innerHTML = '<p style="color:var(--ink-3)">No settled-gameweek usage data.</p>';
    }
  }

  // -------------------------------------------------------------------
  // ANALYTICS (cross-gameweek, a section within Scorecard, not a tab)
  // -------------------------------------------------------------------
  function renderAnalytics(analytics) {
    var versions = (analytics.estimator_versions || {}).versions || {};
    var calib = analytics.calibration || {};
    var arms = analytics.no_prior_arms || {};

    if (!Object.keys(versions).length && !Object.keys(calib.gameweeks || {}).length) {
      $('analytics-sub').textContent = 'analytics.json has no data yet.';
      return;
    }
    $('analytics-sub').textContent = 'Every figure below carries its own n. Below the pre-registered threshold, it reads "not yet meaningful" rather than a number.';

    // --- estimator versions ---
    var vRows = '';
    Object.keys(versions).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (gw) {
      var v = versions[gw];
      var est = v.estimator || {};
      vRows += '<tr><td class="num">GW' + gw + (v.settled ? '' : ' <span class="pill">unsettled</span>') + '</td>' +
        '<td>' + esc(est.commit || '—') + '</td>' +
        '<td>' + esc(est.committed_at || '—') + '</td>' +
        '<td class="decomp">' + esc(est.subject || est.note || '—') + '</td></tr>';
    });
    $('analytics-versions-body').innerHTML = vRows ||
      '<tr><td colspan="4" style="color:var(--ink-3)">No estimator version data.</td></tr>';

    // --- calibration: field-wide and XI, per gw ---
    var gwKeys = Object.keys(calib.gameweeks || {}).sort(function (a, b) { return Number(a) - Number(b); });
    var fieldRows = '', xiRows = '';
    gwKeys.forEach(function (gw) {
      var g = calib.gameweeks[gw];
      if (g.note) {
        fieldRows += '<tr><td class="num">GW' + gw + '</td><td colspan="4" style="color:var(--ink-3)">' + esc(g.note) + '</td></tr>';
        return;
      }
      var fw = g.field_wide || {};
      fieldRows += '<tr><td class="num">GW' + gw + '</td>' +
        '<td class="num">' + (fw.n != null ? fw.n : '—') + '</td>' +
        '<td class="num">' + num(fw.mean_projected, 2) + '</td>' +
        '<td class="num">' + num(fw.mean_actual, 2) + '</td>' +
        '<td class="num">' + num(fw.residual_spread, 2) + '</td></tr>';
      var xiG = (g.xi_level && g.xi_level.gated) || {};
      var xiVal = xiG.meaningful ? xiG.value : null;
      xiRows += '<tr><td class="num">GW' + gw + '</td>' +
        '<td class="num">' + (g.xi_level ? g.xi_level.n : '—') + '</td>' +
        (xiVal ? '<td class="num">' + num(xiVal.mean_projected, 2) + '</td><td class="num">' + num(xiVal.mean_actual, 2) + '</td>'
              : '<td colspan="2" style="color:var(--ink-3)">' + esc((xiG.note) || 'not yet meaningful') + '</td>') +
        '</tr>';
    });
    $('analytics-calib-field-body').innerHTML = fieldRows ||
      '<tr><td colspan="5" style="color:var(--ink-3)">No calibration data yet.</td></tr>';
    $('analytics-calib-xi-body').innerHTML = xiRows ||
      '<tr><td colspan="4" style="color:var(--ink-3)">No calibration data yet.</td></tr>';

    var pooledXi = (calib.pooled_xi_level && calib.pooled_xi_level.gated) || {};
    if (pooledXi.meaningful) {
      $('analytics-calib-xi-note').textContent = 'Pooled across all settled gameweeks (n=' + pooledXi.n + '): mean projected ' +
        num(pooledXi.value.mean_projected, 2) + ', mean actual ' + num(pooledXi.value.mean_actual, 2) + '.';
    } else if (pooledXi.n != null) {
      $('analytics-calib-xi-note').textContent = 'Pooled across all settled gameweeks: ' + esc(pooledXi.note || ('n=' + pooledXi.n + ', not yet meaningful')) + '.';
    }

    // --- deciles, latest settled gw only ---
    var lastGw = gwKeys[gwKeys.length - 1];
    var deciles = (lastGw && calib.gameweeks[lastGw] && calib.gameweeks[lastGw].field_wide)
      ? calib.gameweeks[lastGw].field_wide.deciles || [] : [];
    var decRows = deciles.map(function (d) {
      return '<tr><td class="num">' + d.decile + '</td><td class="num">' + d.n + '</td>' +
        '<td class="num">' + num(d.mean_projected, 2) + '</td><td class="num">' + num(d.mean_actual, 2) + '</td></tr>';
    }).join('');
    $('analytics-deciles-body').innerHTML = decRows ||
      '<tr><td colspan="4" style="color:var(--ink-3)">No decile data yet.</td></tr>';

    // --- no-prior arms, pooled -- CLUSTERED BY GAMEWEEK, not player.
    // A single gameweek's cohort is one cluster however many players it
    // holds, since every no-prior player in it shares the same
    // estimator run -- effective_n (gameweek count) is what the gate is
    // keyed on, raw_n (player count) is shown for reference only.
    // Internal A/B/C/D codes -> plain descriptions of what each method
    // actually does (owner-directed 2026-09-08 jargon sweep).
    var ARM_LABELS = { A: 'Flat average for the position', B: 'Average for similar-priced players',
                      C: 'FPL\'s own projection alone', D: 'Price-based estimate (the one actually used)' };
    var pooled = arms.pooled || {};
    if (pooled.note) {
      $('analytics-arms-body').innerHTML = '<tr><td colspan="5" style="color:var(--ink-3)">' + esc(pooled.note) + '</td></tr>';
      $('analytics-arms-note').textContent = '';
      $('analytics-arms-gw-body').innerHTML = '';
      $('analytics-arms-window-note').textContent = '';
    } else {
      var armRows = ['A', 'B', 'C', 'D'].map(function (key) {
        var a = pooled[key];
        if (!a) return '';
        var maeG = a.mae || {}, spG = a.spearman || {};
        var maeTxt = maeG.meaningful ? num(maeG.value, 3) : (maeG.note || 'not yet meaningful');
        var spTxt = spG.meaningful ? num(spG.value, 4) : (spG.note || 'not yet meaningful');
        return '<tr><td><b>' + esc(ARM_LABELS[key]) + '</b></td>' +
          '<td class="num">' + (maeG.raw_n != null ? maeG.raw_n : '—') + '</td>' +
          '<td class="num">' + (maeG.effective_n != null ? maeG.effective_n : '—') + '</td>' +
          '<td class="num">' + esc(String(maeTxt)) + '</td>' +
          '<td class="num">' + esc(String(spTxt)) + '</td></tr>';
      }).join('');
      $('analytics-arms-body').innerHTML = armRows ||
        '<tr><td colspan="5" style="color:var(--ink-3)">No data yet.</td></tr>';
      $('analytics-arms-note').textContent = 'The price-based estimate is the one actually used for real decisions — it is not assumed to be the best of the four, it is still being checked against actual points like the other three.';

      // Per-gameweek breakdown, with GW1/GW2 explicitly labelled as
      // outside the pre-registration's own scored window (GW3-5) --
      // visible on the page, not only in directives/analytics_json.md.
      var REGISTERED_GWS = [3, 4, 5];
      var gwRows = [];
      ['A', 'B', 'C', 'D'].forEach(function (key) {
        var perGw = (pooled[key] || {}).per_gameweek || [];
        perGw.forEach(function (row) {
          var outside = REGISTERED_GWS.indexOf(row.gw) === -1;
          gwRows.push('<tr><td class="num">GW' + row.gw +
            (outside ? ' <span class="pill warn">before this comparison was set up</span>' : '') + '</td>' +
            '<td>' + esc(ARM_LABELS[key]) + '</td>' +
            '<td class="num">' + row.raw_n + '</td>' +
            '<td class="num">' + num(row.mae, 3) + '</td>' +
            '<td class="num">' + num(row.spearman, 4) + '</td></tr>');
        });
      });
      // Sort by GW then arm, so the table reads gameweek-by-gameweek
      // rather than arm-by-arm (matches how a reader checking "is GW1/2
      // labelled" would scan it).
      gwRows.sort();
      $('analytics-arms-gw-body').innerHTML = gwRows.join('') ||
        '<tr><td colspan="5" style="color:var(--ink-3)">No gameweek-by-gameweek data yet.</td></tr>';
      $('analytics-arms-window-note').textContent = 'Gameweeks 3, 4 and 5 were registered in advance as the ones this comparison would be judged on. Gameweeks 1 and 2 finished before that plan was written and are shown here labelled as such, not hidden.';
    }
  }

  // -------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------
  initTabs();

  Promise.all([
    loadOrEmpty('current.json'),
    loadOrEmpty('history.json'),
    loadOrEmpty('health.json'),
    loadOrEmpty('scorecard.json'),
    loadOrEmpty('field.json'),
    loadOrEmpty('odds.json'),
    loadOrEmpty('analytics.json'),
    loadOrEmpty('players.json'),
  ]).then(function (results) {
    var current = results[0], history = results[1], health = results[2];
    var scorecard = results[3], field = results[4], odds = results[5];
    var analytics = results[6];
    var players = results[7];
    try { renderStrip(current, history, health); } catch (e) { renderError('Status strip', e); }
    try { renderSeasonSummary(current); } catch (e) { renderError('Season summary', e); }
    try { renderWeek(current, field); } catch (e) { renderError('This week', e); }
    try { renderHistory(history); } catch (e) { renderError('History', e); }
    try { renderHealth(health); } catch (e) { renderError('Health', e); }
    try { renderField(field); } catch (e) { renderError('Field', e); }
    try { renderPlayers(players); } catch (e) { renderError('Players', e); }
    try { renderScorecard(scorecard); } catch (e) { renderError('Scorecard', e); }
    try { renderOdds(odds); } catch (e) { renderError('Odds', e); }
    try { renderAnalytics(analytics); } catch (e) { renderError('Analytics', e); }
    // OWNER-CAUGHT 2026-09-07 (failure-swallow sweep): a corrupt
    // decision_*.json used to vanish from every contract with no count
    // anywhere -- current.json/health.json now carry
    // source.skipped_records when the build actually skipped one.
    var skipped = (current.source && current.source.skipped_records) || null;
    if (skipped && skipped.length) {
      renderError('Decision records', new Error(
        skipped.length + ' record(s) could not be read and were skipped: '
        + skipped.map(function (s) { return s.file; }).join(', ')));
    }
    // Leagues needs the Phase 3 Worker proxy (browser CORS blocks the FPL
    // API directly) -- static "not wired yet" panel until then.
  });
})();
