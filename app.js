/* =======================
   CONFIG
======================= */
const DATA = {
  main: 'data/Website_DataSet.csv',              // required
  refs: 'data/reference.csv',                    // required (id,full_reference)
  classLegend: 'data/classification_legend.csv', // required (id,label,description; includes 5)
  qualLegend: 'data/qualifier_legend.csv',       // required (code,description: C,H,O,S,P)
  classes: 'data/drug_classes.csv'               // NEW: drug_name,class (for same-class rule)
};

// Google Form settings (prefilled submission). Replace with your actual formResponse URL & entry IDs.
const GOOGLE_FORM = {
  enabled: false,
  action: 'PASTE_YOUR_GOOGLE_FORM_formResponse_URL_HERE',
  fields: {
    combo_drug_1: 'entry.DRUG1',          // e.g., entry.1111111111
    combo_drug_2: 'entry.DRUG2',
    combo_drug_3: 'entry.DRUG3',
    classification_at_search: 'entry.CLASS',
    q1_used_in_practice: 'entry.Q1',
    q2_more_than_24h: 'entry.Q2',
    q3_diluent_used: 'entry.Q3',
    q4_reaction_observed: 'entry.Q4',
    q5_change_frequency: 'entry.Q5'
  }
};
// --- Background storage + admin download (no user download) ---
// MODE NOTES:
//  - "local"   = saves on the visitor's device only (good for testing/offline).
//  - "form"    = submits to your Google Form (central collection).
//  - "webhook" = POSTs to your own endpoint (Google Apps Script / Sheet / DB).
const BACKEND = {
  mode: 'local',                   // 'local' | 'form' | 'webhook'
  webhookUrl: '',                  // fill only if mode === 'webhook'
};

// A very small CSV accumulator in localStorage.
// IMPORTANT LIMITATION: 'local' mode stores on *the submitter's* browser only.
// For centralised collection, use BACKEND.mode='form' (Google Form) or 'webhook'.
const ReportStore = (() => {
  const KEY = 'syringe_observations_csv_rows_v1';

  const read = () => {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  };

  const write = (rows) => {
    localStorage.setItem(KEY, JSON.stringify(rows));
  };

  const appendRow = (rowObj) => {
    const rows = read();
    rows.push(rowObj);
    write(rows);
  };

  const clear = () => write([]);

  const toCSV = () => {
    const rows = read();
    if (rows.length === 0) return 'No rows';
    const headers = Object.keys(rows[0]);
    const esc = v => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
    };
    const body = rows.map(r => headers.map(h => esc(r[h])).join(',')).join('\n');
    return `${headers.map(esc).join(',')}\n${body}`;
  };

  const downloadCSV = () => {
    const csv = toCSV();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const now = new Date().toISOString().slice(0,10);
    a.href = url;
    a.download = `syringe-observations_ALL_${now}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return { read, appendRow, clear, toCSV, downloadCSV };
})();

// Admin bar appears only when the URL contains ?admin=1
(function injectAdminBarIfNeeded(){
  const params = new URLSearchParams(location.search);
  if (params.get('admin') !== '1') return;

  const bar = document.createElement('div');
  bar.style.cssText = `
    position: fixed; inset: auto 12px 12px auto; z-index: 9999;
    background: #111; color: #fff; padding: 12px 14px; border-radius: 10px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.25); font: 14px/1.2 system-ui, sans-serif;
  `;
  bar.innerHTML = `
    <div style="font-weight:600;margin-bottom:8px;">Admin tools</div>
    <button id="admin-download" style="margin-right:8px;">Download ALL as CSV</button>
    <button id="admin-clear" style="opacity:.9">Clear stored rows</button>
  `;
  document.body.appendChild(bar);

  bar.querySelector('#admin-download').addEventListener('click', () => {
    ReportStore.downloadCSV();
  });
  bar.querySelector('#admin-clear').addEventListener('click', () => {
    if (confirm('Clear ALL locally stored observation rows on this device?')) {
      ReportStore.clear();
      alert('Cleared.');
    }
  });
})();



/* =======================
   CSV PARSER (handles quoted commas)
======================= */
function parseCSV(text){
  const rows = [];
  let i=0, field='', row=[], inQuotes=false;
  const pushField = () => { row.push(field); field=''; };
  const pushRow = () => { rows.push(row); row=[]; };

  while(i < text.length){
    const c = text[i];
    if(inQuotes){
      if(c === '"'){
        if(text[i+1] === '"'){ field += '"'; i+=2; continue; } // escaped quote
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }else{
      if(c === '"'){ inQuotes = true; i++; continue; }
      if(c === ','){ pushField(); i++; continue; }
      if(c === '\r'){ i++; continue; }
      if(c === '\n'){ pushField(); pushRow(); i++; continue; }
      field += c; i++; continue;
    }
  }
  if(field.length || row.length){ pushField(); pushRow(); }
  return rows;
}

async function loadCSV(url){
  const res = await fetch(url);
  const txt = await res.text();
  const rows = parseCSV(txt).filter(r => r.length && r.join('').trim().length);
  const headers = rows[0].map(h => h.trim());
  const out = rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h,idx)=> obj[h] = ((r[idx] ?? '') + '').trim());
    return obj;
  });
  return {headers, rows: out};
}

/* =======================
   HELPERS & STATE
======================= */
const norm = s => (s||'').toString().trim().toLowerCase().replace(/\s+/g,' ');
const uniq = arr => [...new Set(arr)];
const nonEmpty = x => x && x.trim().length;

// conservative precedence: 3 (incompatible) > 5 (not recommended) > 2 > 7 > 6 > 1
const precedence = { "3":6, "5":5, "2":4, "7":3, "6":2, "1":1 };

const classificationLabels = new Map(); // id -> {label, description}
const qualifierLabels = new Map();      // code -> description
const refsMap = new Map();              // id -> full_reference
let dataset = [];
let classMap = new Map();               // canon drug -> class

/* UI refs */
const drug1Sel = document.getElementById('drug1');
const drug2Sel = document.getElementById('drug2');
const drug3Sel = document.getElementById('drug3');
const resultsEl = document.getElementById('results');

function setOptions(selectEl, values){
  selectEl.innerHTML = '';
  const blankOpt = document.createElement('option');
  blankOpt.value = '';
  blankOpt.textContent = '— Select —';
  selectEl.appendChild(blankOpt);
  values.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    selectEl.appendChild(opt);
  });
}

function keyFor(drugs){
  return drugs.map(norm).filter(Boolean).sort().join(' | ');
}

function buildDrugOptions(){
  const names = [];
  dataset.forEach(r => {
    if(nonEmpty(r.raw.drug_1)) names.push(r.raw.drug_1);
    if(nonEmpty(r.raw.drug_2)) names.push(r.raw.drug_2);
    if(nonEmpty(r.raw.drug_3)) names.push(r.raw.drug_3);
  });
  const canonSeen = new Set();
  const displayList = [];
  names.forEach(n => {
    const c = norm(n);
    if(!canonSeen.has(c)){ canonSeen.add(c); displayList.push(n); }
  });
  displayList.sort((a,b)=>a.localeCompare(b, undefined, {sensitivity:'base'}));
  setOptions(drug1Sel, displayList);
  setOptions(drug2Sel, displayList);
  setOptions(drug3Sel, displayList);
}

function findMatches(drugs){
  const k = keyFor(drugs);
  return dataset.filter(r => r.key === k);
}

/* ===== Same-class rule (SCV p.3) ===== */
const FLAG_CLASSES = new Set(['Opioid','Dopamine antagonist']); // extend if needed

function sharedFlagClass(drugs){
  const counts = {};
  drugs.map(d => d||'')
       .map(s => s.toLowerCase().replace(/\s+/g,' '))
       .forEach(k => {
         const cls = classMap.get(k);
         if(!cls) return;
         counts[cls] = (counts[cls]||0) + 1;
       });
  for(const cls of Object.keys(counts)){
    if(FLAG_CLASSES.has(cls) && counts[cls] >= 2) return cls;
  }
  return null;
}

/* ===== Summarise rows per diluent ===== */
function summariseByDiluent(records){
  const by = new Map();
  records.forEach(r => {
    const d = r.diluent;
    if(!by.has(d)) by.set(d, []);
    by.get(d).push(r);
  });
  const summaries = [];
  by.forEach((rows, diluent)=>{
    const classes = rows.map(x => (x.classification||'').trim()).filter(Boolean);
    const best = classes.sort((a,b) => (precedence[b]||0)-(precedence[a]||0))[0] || '';
    const quals = uniq(rows.flatMap(x => (x.qualifiers||'').split(/[\s,\|]+/).filter(Boolean)));
    const refs  = uniq(rows.flatMap(x => (x.reference_ids||'').split(',').map(s=>s.trim()).filter(Boolean)));
    summaries.push({ diluent, classification: best, qualifiers: quals, references: refs });
  });
  // Preferred order: Water for injection, Sodium chloride 0.9%, then others if any
  summaries.sort((a,b)=>{
    const score = s => s === 'Water for injection' ? 0 : s === 'Sodium chloride 0.9%' ? 1 : 2;
    return score(a.diluent) - score(b.diluent);
  });
  return summaries;
}

function clsBadge(code){ return `badge c${code}`; }

function refsHtml(refIds){
  if(!refIds.length) return '';
  const items = refIds.map(id => `<li>${id}. ${refsMap.get(id) || ('Reference '+id)}</li>`).join('');
  return `<div class="section-title">References</div><ul class="refs">${items}</ul>`;
}

function qualsHtml(qualCodes){
  if(!qualCodes.length) return '';
  const chips = qualCodes.map(code => {
    const txt = qualifierLabels.get(code) || '';
    return `<span class="qual">${txt}</span>`;
  }).join('');
  return `<div class="section-title">Qualifiers</div><div class="qualifiers">${chips}</div>`;
}

/* ===== Render results + observation form ===== */
function renderResult(drugs, summaries){
  resultsEl.innerHTML = '';

  if(!summaries.length){
    // No data
    const wrap = document.createElement('div');
    wrap.className = 'result';
    wrap.innerHTML = `
      <h3>${drugs.filter(Boolean).join(' + ')}</h3>
      <div class="badges"><span class="badge c4">No data</span></div>
      <p class="meta">No published compatibility found for this combination. Consider separate infusions and seek specialist advice.</p>
    `;
    resultsEl.appendChild(wrap);
    renderObservationPanel(drugs, /*noData*/true, /*anecdotal*/false);
    return;
  }

  let anyAnecdotal = false;
  summaries.forEach(s => {
    const cls = classificationLabels.get((s.classification||'').toString()) || {label:'', description:''};
    if(s.classification === '1') anyAnecdotal = true;

    const wrap = document.createElement('div');
    wrap.className = 'result';
    wrap.innerHTML = `
      <h3>${drugs.filter(Boolean).join(' + ')}</h3>
      <div class="badges">
        <span class="badge diluent">${s.diluent}</span>
        <span class="${clsBadge(s.classification)}">${cls.label}</span>
      </div>
      <p class="meta">${cls.description}</p>
      ${qualsHtml(s.qualifiers)}
      ${refsHtml(s.references)}
    `;
    resultsEl.appendChild(wrap);
  });

  // If any diluent result is anecdotal (1), show Q1 panel
  if(anyAnecdotal){
    renderObservationPanel(drugs, /*noData*/false, /*anecdotal*/true);
  }
}

/* ===== Observation panel -> Google Form ===== */
function renderObservationPanel(drugs, noData, anecdotal){
  // Which centralisation path are we using?
  // - BACKEND.mode === 'form'    => send to Google Form (GOOGLE_FORM.* must be set)
  // - BACKEND.mode === 'webhook' => POST JSON to your endpoint (see below)
  // - BACKEND.mode === 'local'   => accumulate in localStorage (on submitter’s device)
  const usingGoogleForm = (BACKEND.mode === 'form');

  const panel = document.createElement('div');
  panel.className = 'panel obs';

  const buildSelect = (id, labelText, options) => {
    const wrap = document.createElement('label');
    const title = document.createElement('span');
    title.textContent = labelText;

    const sel = document.createElement('select');
    sel.id = id;

    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = 'Please Select';
    ph.selected = true;
    sel.appendChild(ph);

    (options || []).forEach(v => {
      const opt = document.createElement('option');
      opt.value = (v.value ?? v);
      opt.textContent = (v.label ?? v);
      sel.appendChild(opt);
    });

    wrap.appendChild(title);
    wrap.appendChild(sel);
    return wrap;
  };

  const grid = document.createElement('div');
  grid.className = 'grid';

  // Q1 (always asked)
  grid.appendChild(buildSelect('q1', 'Was this combination used in clinical practice?', [
    {label:'Yes', value:'Yes'},
    {label:'No',  value:'No'}
  ]));

  if(noData){
    grid.appendChild(buildSelect('q2', 'Did the combination appear compatible?', [
      {label:'Yes', value:'Yes'},
      {label:'No',  value:'No'}
    ]));
    grid.appendChild(buildSelect('q3', 'How frequently was the infusion changed?', [
      {label:'24 hours', value:'24'},
      {label:'48 hours', value:'48'},
      {label:'> 48 hours', value:'> 48'}
    ]));
    grid.appendChild(buildSelect('q4', 'What diluent was used?', [
      'Water for injection', 'Sodium chloride 0.9%', 'No diluent', 'Other'
    ]));
    grid.appendChild(buildSelect('q5', 'Was there an infusion reaction observed?', [
      {label:'Yes', value:'Yes'},
      {label:'No',  value:'No'}
    ]));
    grid.appendChild(buildSelect('q6', 'Was this combination administered for more than 24 hours?', [
      {label:'Yes', value:'Yes'},
      {label:'No',  value:'No'}
    ]));
  }

  panel.innerHTML = `
    <h4>Safer Care Victoria is collecting data on combinations used in practice to better inform future compatibility testing.</h4>
  `;
  panel.appendChild(grid);

  const confirm = document.createElement('p');
  confirm.className = 'confirm-text';
  confirm.textContent = 'I confirm this is an observational report, de-identified, for quality improvement and to inform future compatibility research.';
  panel.appendChild(confirm);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn';
  btn.id = 'openForm';
  btn.textContent = 'Submit';
  btn.disabled = true;
  panel.appendChild(btn);

  const hint = document.createElement('p');
  hint.className = 'meta';
  hint.textContent = 'Complete all fields to enable Submit.';
  panel.appendChild(hint);

  resultsEl.appendChild(panel);

  // ---- validation
  const requiredIds = noData ? ['q1','q2','q3','q4','q5','q6'] : ['q1'];
  const get = id => /** @type {HTMLSelectElement} */(document.getElementById(id));
  const isComplete = () => requiredIds.every(id => (get(id)?.value ?? '') !== '');
  const refreshState = () => { btn.disabled = !isComplete(); };
  requiredIds.forEach(id => get(id)?.addEventListener('change', refreshState));
  refreshState();

  // ---- submission
  const [d1,d2,d3] = [drugs[0]||'', drugs[1]||'', drugs[2]||''];
  const ctxLabel = noData ? 'No data' : (anecdotal ? 'Appears compatible (anecdotal)' : 'Appears compatible');

  const buildRowObject = () => {
    const base = {
      datetime_iso: new Date().toISOString(),
      drug_1: d1, drug_2: d2, drug_3: d3,
      classification_at_search: ctxLabel,
      used_in_practice: get('q1').value
    };
    if(noData){
      base.appeared_compatible = get('q2').value;
      base.change_frequency_hours = get('q3').value;
      base.diluent_used = get('q4').value;
      base.reaction_observed = get('q5').value;
      base.administered_more_than_24h = get('q6').value;
    }
    return base;
  };

  const sendToWebhook = async (payload) => {
    const resp = await fetch(BACKEND.webhookUrl, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    if(!resp.ok) throw new Error(`Webhook error: ${resp.status}`);
  };

  const sendToGoogleForm = () => {
    const params = new URLSearchParams();
    const F = GOOGLE_FORM.fields;

    params.set(F.combo_drug_1, d1);
    params.set(F.combo_drug_2, d2);
    if(d3) params.set(F.combo_drug_3, d3);
    params.set(F.classification_at_search, ctxLabel);
    params.set(F.q1_used_in_practice, get('q1').value);

    if(noData){
      // map to your existing field IDs (adjust as needed)
      params.set(F.q2_more_than_24h,      get('q6').value);
      params.set(F.q3_diluent_used,       get('q4').value);
      params.set(F.q4_reaction_observed,  get('q5').value);
      params.set(F.q5_change_frequency,   get('q3').value);
      // add a new Google Form field for "appeared compatible" if desired
      // params.set(F.qX_appeared_compatible, get('q2').value);
    }

    const url = `${GOOGLE_FORM.action}?${params.toString()}`;
    // Background submit without opening a new tab:
    navigator.sendBeacon?.(url) || fetch(url, {mode:'no-cors'}).catch(()=>{});
  };

  const showThankYou = () => {
    panel.innerHTML = `
      <div class="thankyou">
        <h4>Thank you for providing the observational report.</h4>
        <p>Your response has been recorded.</p>
      </div>
    `;
  };

  btn.addEventListener('click', async ()=>{
    if(btn.disabled) return;

    const row = buildRowObject();

    try {
      if (BACKEND.mode === 'form') {
        sendToGoogleForm();
      } else if (BACKEND.mode === 'webhook') {
        await sendToWebhook(row);
      } else {
        // local mode (background save to this device only)
        ReportStore.appendRow(row);
      }
      showThankYou();
    } catch (e) {
      alert('Sorry, there was a problem saving your report. Please try again.');
      console.error(e);
    }
  });
}

/* =======================
   INIT
======================= */
async function init(){
  // legends
  try{
    const [cl, ql] = await Promise.all([
      loadCSV(DATA.classLegend),
      loadCSV(DATA.qualLegend)
    ]);
    cl.rows.forEach(r => classificationLabels.set((r.id||'').trim(), {label:r.label||'', description:r.description||''}));
    ql.rows.forEach(r => qualifierLabels.set((r.code||'').trim(), (r.description||'')));
  }catch(e){ console.warn('Legend files missing?', e); }

  // references
  try{
    const {rows} = await loadCSV(DATA.refs);
    rows.forEach(r => { if(r.id) refsMap.set(r.id.trim(), (r.full_reference||'').trim()); });
  }catch(e){ console.warn('reference.csv missing?', e); }

  // class map (same-class rule)
  try{
    const {rows} = await loadCSV(DATA.classes);
    rows.forEach(r=>{
      const name = (r.drug_name||'').trim();
      const cls  = (r.class||'').trim();
      if(name && cls) classMap.set((name.toLowerCase().replace(/\s+/g,' ')), cls);
    });
  }catch(e){ console.warn('drug_classes.csv missing?', e); }

  // dataset
  const main = await loadCSV(DATA.main);
  dataset = main.rows.map(r => {
    const a = r.drug_1||''; const b = r.drug_2||''; const c = r.drug_3||'';
    return {
      raw: r,
      key: keyFor([a,b,c]),
      drugs: [a,b,c].filter(Boolean),
      diluent: r.diluent||'',
      classification: (r.classification||'').trim(),   // "1","2","3","5","6","7"
      qualifiers: (r.qualifiers||'').trim(),           // letters: C,H,O,S,P (comma/pipe ok)
      reference_ids: (r.reference_ids||'').trim()
    };
  });

  // dropdowns
  buildDrugOptions();

  // search
  document.getElementById('searchForm').addEventListener('submit', (e)=>{
    e.preventDefault();
    const d1 = drug1Sel.value, d2 = drug2Sel.value, d3 = drug3Sel.value;
    if(!nonEmpty(d1) || !nonEmpty(d2)){ alert('Please select at least two medicines.'); return; }

    const chosen = d3 ? [d1,d2,d3] : [d1,d2];

    // apply same-class rule (Code 5) before any dataset lookup
    const clsHit = sharedFlagClass(chosen);
    if(clsHit){
      // This class-based rule applies regardless of diluent — present a single black badge
      const summaries = [{
        diluent: '—',
        classification: '5',
        qualifiers: [],
        references: []
      }];
      renderResult(chosen, summaries);
      return;
    }

    const matches = findMatches(chosen);
    const summaries = summariseByDiluent(matches);
    renderResult(chosen, summaries);
  });

  // footer version stamp
  const vEl = document.getElementById('dataVersion');
  if(vEl) vEl.textContent = new Date().toISOString().slice(0,10);
}
init();
