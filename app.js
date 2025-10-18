/* ====== Data paths ====== */
const DATA = {
  main: 'data/Website_DataSet.csv',                 // required
  refs: 'data/references.csv',                      // optional: id,full_reference
  classLegend: 'data/classification_legend.csv',    // optional: id,label,description
  qualLegend: 'data/qualifier_legend.csv'           // optional: code,description
};

/* ====== Lightweight CSV loader (simple split) ====== */
async function loadCSV(url){
  const res = await fetch(url);
  const text = await res.text();
  const lines = text.replace(/\r/g,'').split('\n').filter(x => x.trim().length);
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const parts = line.split(',');
    const obj = {};
    headers.forEach((h,i) => obj[h] = (parts[i] ?? '').trim());
    return obj;
  });
  return {headers, rows};
}

/* ====== Helpers ====== */
const norm = s => (s||'').toString().trim().toLowerCase().replace(/\s+/g,' ');
const uniq = arr => [...new Set(arr)];
const nonEmpty = x => x && x.trim().length;
const badgeClass = code => `badge c${code}`;
const precedence = { "3":5, "2":4, "7":3, "6":2, "1":1 }; // most conservative first

/* ====== Lookup maps ====== */
const classificationLabels = new Map(); // id -> {label, description}
const qualifierLabels = new Map();      // code -> description
const refsMap = new Map();              // id -> full_reference

/* ====== Dataset ====== */
let dataset = [];   // normalized objects
let displayNameByCanon = new Map(); // canonical -> original display name

/* ====== UI Elements ====== */
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

function renderLegend(){
  const lc = document.getElementById('legendClassifications');
  lc.innerHTML = '';
  [...classificationLabels.entries()]
    .sort((a,b) => parseInt(a[0]) - parseInt(b[0]))
    .forEach(([id, obj])=>{
      const el = document.createElement('div');
      el.className = 'legend-item';
      el.innerHTML = `
        <h4><span class="badge ${badgeClass(id)}">Code ${id}</span> ${obj.label}</h4>
        <p class="meta">${obj.description}</p>
      `;
      lc.appendChild(el);
    });

  const lq = document.getElementById('legendQualifiers');
  lq.innerHTML = '';
  [...qualifierLabels.entries()]
    .sort((a,b) => a[0].localeCompare(b[0]))
    .forEach(([code, desc])=>{
      const el = document.createElement('div');
      el.className = 'legend-item';
      el.innerHTML = `<h4>Qualifier ${code}</h4><p class="meta">${desc}</p>`;
      lq.appendChild(el);
    });
}

/* ====== Build display set from dataset ====== */
function buildDrugOptions(){
  const names = [];
  dataset.forEach(r => {
    if(nonEmpty(r.raw.drug_1)) names.push(r.raw.drug_1);
    if(nonEmpty(r.raw.drug_2)) names.push(r.raw.drug_2);
    if(nonEmpty(r.raw.drug_3)) names.push(r.raw.drug_3);
  });
  // Canonicalize → pick first seen as display
  const canonSeen = new Set();
  const displayList = [];
  names.forEach(name => {
    const canon = norm(name);
    if(!canonSeen.has(canon)){
      canonSeen.add(canon);
      displayNameByCanon.set(canon, name); // preserve first appearance casing
      displayList.push(name);
    }
  });
  displayList.sort((a,b) => a.localeCompare(b, undefined, {sensitivity:'base'}));
  setOptions(drug1Sel, displayList);
  setOptions(drug2Sel, displayList);
  setOptions(drug3Sel, displayList);
}

/* ====== Matching logic (order-agnostic, 2 or 3 drugs) ====== */
function keyFor(drugs){
  return drugs.map(norm).filter(Boolean).sort().join(' | ');
}

function findMatches(drugs){
  const k = keyFor(drugs);
  return dataset.filter(r => r.key === k);
}

function summariseByDiluent(records){
  // Group by diluent; collapse classification conservatively; union qualifiers and references
  const byDil = new Map();
  records.forEach(r => {
    const d = r.diluent;
    if(!byDil.has(d)) byDil.set(d, []);
    byDil.get(d).push(r);
  });
  const summaries = [];
  byDil.forEach((rows, diluent) => {
    const classes = rows.map(x => (x.classification||'').trim()).filter(Boolean);
    const best = classes.sort((a,b) => (precedence[b]||0) - (precedence[a]||0))[0] || ''; // 3>2>7>6>1
    const quals = uniq(rows.flatMap(x => (x.qualifiers||'').split(/[\s,\|]+/).filter(Boolean)));
    const refs  = uniq(rows.flatMap(x => (x.reference_ids||'').split(',').map(s=>s.trim()).filter(Boolean)));
    summaries.push({ diluent, classification: best, qualifiers: quals, references: refs });
  });
  // Sort: WFI then NaCl for readability
  summaries.sort((a,b) => a.diluent.localeCompare(b.diluent));
  return summaries;
}

function renderReferences(refIds){
  if(!refIds.length) return '';
  const items = refIds.map(id => `<li>${id}. ${refsMap.get(id) || 'Reference ' + id}</li>`).join('');
  return `<div><strong>References</strong><ul>${items}</ul></div>`;
}

function renderQualifiers(qualCodes){
  if(!qualCodes.length) return '';
  return `<div class="qualifiers">
    ${qualCodes.map(q => `<span class="qual">${q}: ${qualifierLabels.get(q) || ''}</span>`).join('')}
  </div>`;
}

function renderDiluentSummary(drugLabels, summaries){
  resultsEl.innerHTML = '';
  if(!summaries.length){
    const wrap = document.createElement('div');
    wrap.className = 'result';
    wrap.innerHTML = `
      <h3>${drugLabels.filter(Boolean).join(' + ')}</h3>
      <div class="badges"><span class="badge c3">No data</span></div>
      <p class="meta">No published compatibility found for this combination. Consider separate infusions and seek specialist advice.</p>
    `;
    resultsEl.appendChild(wrap);
    return;
  }

  summaries.forEach(s => {
    const clsEntry = classificationLabels.get((s.classification||'').toString()) || {label:'', description:''};
    const wrap = document.createElement('div');
    wrap.className = 'result';
    wrap.innerHTML = `
      <h3>${drugLabels.filter(Boolean).join(' + ')}</h3>
      <div class="badges">
        <span class="badge diluent">${s.diluent}</span>
        <span class="badge ${badgeClass(s.classification)}">${s.classification} – ${clsEntry.label}</span>
      </div>
      <p class="meta">${clsEntry.description}</p>
      ${renderQualifiers(s.qualifiers)}
      ${renderReferences(s.references)}
    `;
    resultsEl.appendChild(wrap);
  });
}

/* ====== Init ====== */
async function init(){
  // Load legends (optional but recommended)
  try{
    const [cl, ql] = await Promise.all([
      loadCSV(DATA.classLegend),
      loadCSV(DATA.qualLegend)
    ]);
    cl.rows.forEach(r => classificationLabels.set((r.id||'').trim(), {label:r.label||'', description:r.description||''}));
    ql.rows.forEach(r => qualifierLabels.set((r.code||'').trim(), (r.description||'')));
  }catch{ /* okay if not present */ }

  // Load references (optional)
  try{
    const {rows} = await loadCSV(DATA.refs);
    rows.forEach(r => { if(r.id) refsMap.set(r.id.trim(), (r.full_reference||'').trim()); });
  }catch{ /* okay if not present */ }

  // Load main dataset
  const main = await loadCSV(DATA.main);
  dataset = main.rows.map(r => {
    const a = r.drug_1||''; const b = r.drug_2||''; const c = r.drug_3||'';
    return {
      raw: r,
      key: keyFor([a,b,c]),
      drugs: [a,b,c].filter(Boolean),
      diluent: r.diluent||'',
      classification: (r.classification||'').trim(),   // numeric code: 1,2,3,6,7
      qualifiers: (r.qualifiers||'').trim(),           // letters: C,H,O,S,P (comma or pipe separated ok)
      reference_ids: (r.reference_ids||'').trim()
    };
  });

  // Build dropdowns from all unique drug names found across columns
  buildDrugOptions();

  // Form submit
  document.getElementById('searchForm').addEventListener('submit', (e)=>{
    e.preventDefault();
    const d1 = drug1Sel.value;
    const d2 = drug2Sel.value;
    const d3 = drug3Sel.value;

    if(!nonEmpty(d1) || !nonEmpty(d2)){
      alert('Please select at least two medicines.');
      return;
    }

    const chosenDrugs = d3 ? [d1,d2,d3] : [d1,d2];
    const matches = findMatches(chosenDrugs);

    // Summarise across diluents present in your CSV (WFI, NaCl 0.9%, etc.)
    const summaries = summariseByDiluent(matches);
    renderDiluentSummary(chosenDrugs, summaries);
  });

  // Version stamp
  document.getElementById('dataVersion').textContent = new Date().toISOString().slice(0,10);
  renderLegend();
}

init();
