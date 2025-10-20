/* =======================
   CONFIG
======================= */
const DATA = {
  main: 'data/Website_DataSet.csv',
  refs: 'data/reference.csv',
  classLegend: 'data/classification_legend.csv',
  qualLegend: 'data/qualifier_legend.csv'
};

// Set this to your Google Form "formResponse" URL.
// Example: 'https://docs.google.com/forms/d/e/XXXXXXXXXXXX/formResponse'
const GOOGLE_FORM = {
  enabled: true,
  action: 'PASTE_YOUR_GOOGLE_FORM_formResponse_URL_HERE',
  // Map your Google Form entry IDs to fields we will send.
  // Find these by creating a "prefilled link" in Google Forms and copying the `entry.123456` params.
  fields: {
    // Core context:
    combo_drug_1: 'entry.DRUG1',          // e.g., entry.1111111111
    combo_drug_2: 'entry.DRUG2',
    combo_drug_3: 'entry.DRUG3',
    classification_at_search: 'entry.CLASS',
    // Q1–Q5:
    q1_used_in_practice: 'entry.Q1',
    q2_more_than_24h: 'entry.Q2',
    q3_diluent_used: 'entry.Q3',
    q4_reaction_observed: 'entry.Q4',
    q5_change_frequency: 'entry.Q5'
  }
};

/* =======================
   LIGHTWEIGHT CSV PARSER (handles quoted commas)
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
  if(field.length || row.length) { pushField(); pushRow(); }
  return rows;
}
async function loadCSV(url){
  const res = await fetch(url);
  const txt = await res.text();
  const rows = parseCSV(txt).filter(r => r.length && r.join('').trim().length);
  const headers = rows[0].map(h => h.trim());
  const out = rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h,idx)=> obj[h] = (r[idx] ?? '').trim());
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

// conservative precedence across duplicates in same diluent
const precedence = { "3":5, "2":4, "7":3, "6":2, "1":1 }; // no 4 here; "no data" means no row

const classificationLabels = new Map(); // id -> {label, description}
const qualifierLabels = new Map();      // code -> description
const refsMap = new Map();              // id -> full_reference
let dataset = [];

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

// group rows by diluent and summarise
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
  // sort diluents helpful order: Water for injection first
  summaries.sort((a,b)=>{
    const score = s => s === 'Water for injection' ? 0 : s === 'Sodium chloride 0.9%' ? 1 : 2;
    return score(a.diluent) - score(b.diluent);
  });
  return summaries;
}

function clsBadge(code){
  // map numeric -> class string
  return `badge c${code}`;
}

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

function renderResult(drugs, summaries){
  resultsEl.innerHTML = '';
  if(!summaries.length){
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

  // show one card per diluent
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

/* ====== Observation panel (Google Form) ====== */
function renderObservationPanel(drugs, noData, anecdotal){
  if(!GOOGLE_FORM.enabled) return;

  const panel = document.createElement('div');
  panel.className = 'panel obs';
  panel.innerHTML = `
    <h4>Safer Care Victoria is collecting data on combinations used in practice to better inform future compatibility testing.</h4>
    <div class="grid">
      <label>Was this combination used in clinical practice?
        <select id="q1"><option>Yes</option><option>No</option></select>
      </label>
      ${noData ? `
      <label>Was this infusion administered for more than 24 hours?
        <select id="q2"><option>Yes</option><option>No</option></select>
      </label>
      <label>What diluent was used?
        <select id="q3"><option>Water for injection</option><option>Sodium chloride 0.9%</option><option>No diluent</option><option>Other</option></select>
      </label>
      <label>Was there an infusion reaction observed?
        <select id="q4"><option>No</option><option>Yes</option></select>
      </label>
      <label>How frequently was the infusion changed?
        <select id="q5"><option>24</option><option>48</option><option>&gt; 48</option></select>
      </label>` : ``}
    </div>
    <button type="button" class="btn" id="openForm">Submit via Google Form</button>
    <p class="meta">A new tab will open with your responses pre-filled. You can review and submit there.</p>
  `;
  resultsEl.appendChild(panel);

  document.getElementById('openForm').addEventListener('click', ()=>{
    const params = new URLSearchParams();
    const F = GOOGLE_FORM.fields;
    const [d1,d2,d3] = [drugs[0]||'', drugs[1]||'', drugs[2]||''];

    params.set(F.combo_drug_1, d1);
    params.set(F.combo_drug_2, d2);
    if(d3) params.set(F.combo_drug_3, d3);

    // classification context: "1" for anecdotal, "4" for no data
    params.set(F.classification_at_search, noData ? 'No data' : 'Appears compatible');

    params.set(F.q1_used_in_practice, document.getElementById('q1').value);
    if(noData){
      params.set(F.q2_more_than_24h, document.getElementById('q2').value);
      params.set(F.q3_diluent_used, document.getElementById('q3').value);
      params.set(F.q4_reaction_observed, document.getElementById('q4').value);
      params.set(F.q5_change_frequency, document.getElementById('q5').value);
    }

    const url = `${GOOGLE_FORM.action}?${params.toString()}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  });
}

/* ====== INIT ====== */
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

  // dataset
  const main = await loadCSV(DATA.main);
  dataset = main.rows.map(r => {
    const a = r.drug_1||''; const b = r.drug_2||''; const c = r.drug_3||'';
    return {
      raw: r,
      key: keyFor([a,b,c]),
      drugs: [a,b,c].filter(Boolean),
      diluent: r.diluent||'',
      classification: (r.classification||'').trim(),   // numeric code: 1,2,3,6,7
      qualifiers: (r.qualifiers||'').trim(),           // letters: C,H,O,S,P
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
    const matches = findMatches(chosen);
    const summaries = summariseByDiluent(matches);

    renderResult(chosen, summaries);
  });

  document.getElementById('dataVersion').textContent = new Date().toISOString().slice(0,10);
}
init();
