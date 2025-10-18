/* ====== Configuration ====== */
const DATA = {
  main: 'data/Website_DataSet.csv',           // your uploaded compatibility CSV
  refs: 'data/references.csv',                // optional: id,full_reference
  classLegend: 'data/classification_legend.csv', // id,label,description
  qualLegend: 'data/qualifier_legend.csv'     // code,description
};

// Simple CSV loader (expects no quoted commas; your schema fits this)
async function loadCSV(url){
  const res = await fetch(url);
  const text = await res.text();
  const lines = text.replace(/\r/g,'').split('\n').filter(Boolean);
  const headers = lines[0].split(',').map(h=>h.trim());
  const rows = lines.slice(1).map(line=>{
    const parts = line.split(','); // simple split; keep fields simple in CSV
    const obj = {};
    headers.forEach((h,i)=> obj[h.trim()] = (parts[i]||'').trim());
    return obj;
  });
  return {headers, rows};
}

const norm = s => (s||'').toString().trim().toLowerCase().replace(/\s+/g,' ');
const badgeClass = code => `badge c${code}`;
const classificationLabels = new Map(); // id -> {label, description}
const qualifierLabels = new Map();      // code -> description
const refsMap = new Map();              // id -> full_reference
let dataset = [];                       // normalized rows

function parseRefIds(s){
  if(!s) return [];
  return s.split(',').map(x=>x.trim()).filter(Boolean);
}

function drugsKey(a,b,c){
  const list = [norm(a), norm(b), norm(c||'')].filter(Boolean).sort();
  return list.join(' | ');
}

function renderLegend(){
  const lc = document.getElementById('legendClassifications');
  lc.innerHTML = '';
  [...classificationLabels.entries()].sort((a,b)=>parseInt(a[0]) - parseInt(b[0])).forEach(([id, obj])=>{
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
  [...qualifierLabels.entries()].sort().forEach(([code, desc])=>{
    const el = document.createElement('div');
    el.className = 'legend-item';
    el.innerHTML = `<h4>Qualifier ${code}</h4><p class="meta">${desc}</p>`;
    lq.appendChild(el);
  });
}

function showResultCard({drugs, diluent, classification, qualifiers, reference_ids}){
  const results = document.getElementById('results');
  results.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'result';

  const clsEntry = classificationLabels.get(classification) || {label:'Unknown', description:''};
  const qualChips = (qualifiers||'')
    .split(/[\|\s,]+/)
    .filter(Boolean)
    .map(q => `<span class="qual">${q}: ${qualifierLabels.get(q)||''}</span>`)
    .join('');

  const refItems = parseRefIds(reference_ids).map(id=>{
    const text = refsMap.get(id) || `Reference ${id}`;
    return `<li>${id}. ${text}</li>`;
  }).join('');

  wrap.innerHTML = `
    <h3>${drugs.filter(Boolean).join(' + ')}</h3>
    <div class="badges">
      <span class="badge diluent">${diluent}</span>
      <span class="badge ${badgeClass(classification)}">${classification} – ${clsEntry.label}</span>
    </div>
    <p class="meta">${clsEntry.description}</p>
    ${qualChips ? `<div class="qualifiers">${qualChips}</div>` : ``}
    ${refItems ? `<div><strong>References</strong><ul>${refItems}</ul></div>` : ``}
  `;
  results.appendChild(wrap);
}

function showNoData(drugs, diluent){
  const results = document.getElementById('results');
  results.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'result';
  wrap.innerHTML = `
    <h3>${drugs.filter(Boolean).join(' + ')}</h3>
    <div class="badges"><span class="badge diluent">${diluent}</span>
    <span class="badge c4">No data</span></div>
    <p class="meta">No published compatibility found for this combination/diluent. You can record an observation below (5 quick questions) to support future updates.</p>
    <form id="obsForm" class="panel" style="margin-top:12px">
      <div class="grid">
        <label>Was this combination used in clinical practice?
          <select id="obs_used"><option>Yes</option><option>No</option></select>
        </label>
        <label>Infused &gt; 24 hours?
          <select id="obs_24h"><option>Yes</option><option>No</option></select>
        </label>
        <label>Diluent used
          <select id="obs_diluent">
            <option>Water for Injection</option>
            <option>Sodium Chloride 0.9%</option>
            <option>No diluent</option>
            <option>Other</option>
          </select>
        </label>
        <label>Infusion reaction observed?
          <select id="obs_reaction"><option>No</option><option>Yes</option></select>
        </label>
        <label>Change frequency
          <select id="obs_freq"><option>24</option><option>48</option><option>&gt;48</option></select>
        </label>
      </div>
      <button type="button" class="btn" id="obsDownload">Download CSV entry</button>
    </form>
    <p class="meta">Tip: attach the downloaded row to an email or upload to your private repository for later triage.</p>
  `;
  results.appendChild(wrap);

  document.getElementById('obsDownload').addEventListener('click', ()=>{
    const row = {
      timestamp_iso: new Date().toISOString(),
      drug_1: drugs[0]||'',
      drug_2: drugs[1]||'',
      drug_3: drugs[2]||'',
      was_used_in_practice: document.getElementById('obs_used').value,
      infusion_more_than_24h: document.getElementById('obs_24h').value,
      diluent_used: document.getElementById('obs_diluent').value,
      infusion_reaction_observed: document.getElementById('obs_reaction').value,
      change_frequency: document.getElementById('obs_freq').value
    };
    const headers = Object.keys(row);
    const csv = headers.join(',') + '\n' + headers.map(h=>row[h]).join(',');
    const blob = new Blob([csv], {type:'text/csv'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'observation_entry.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

function findMatch(drugs, diluent){
  const key = drugsKey(drugs[0], drugs[1], drugs[2]);
  // Search exact unordered drug match + same diluent
  const hit = dataset.find(r => r.key === key && r.diluent_n === norm(diluent));
  return hit || null;
}

async function init(){
  // Load legends
  try{
    const [cl, ql] = await Promise.all([
      loadCSV(DATA.classLegend),
      loadCSV(DATA.qualLegend)
    ]);
    cl.rows.forEach(r=>{
      classificationLabels.set((r.id||'').trim(), {label:r.label||'', description:r.description||''});
    });
    ql.rows.forEach(r=>{
      qualifierLabels.set((r.code||'').trim(), r.description||'');
    });
  }catch(e){
    console.warn('Legend files not found yet. You can add them later.', e);
  }

  // Load references (optional)
  try{
    const {rows} = await loadCSV(DATA.refs);
    rows.forEach(r=>{
      if(r.id) refsMap.set(r.id.trim(), (r.full_reference||'').trim());
    });
  }catch(e){
    console.warn('No references.csv found (optional).', e);
  }

  // Load main dataset
  const main = await loadCSV(DATA.main);
  dataset = main.rows.map(r=>{
    const a = r.drug_1||''; const b = r.drug_2||''; const c = r.drug_3||'';
    const dil = r.diluent||'';
    return {
      raw: r,
      key: drugsKey(a,b,c),
      drugs: [a,b,c].filter(Boolean),
      diluent: dil,
      diluent_n: norm(dil),
      classification: (r.classification||'').trim(),             // numeric code, e.g., "1","2","3","6","7"
      qualifiers: (r.qualifiers||'').trim(),                     // letters, e.g., "C,H"
      reference_ids: (r.reference_ids||'').trim()
    };
  });

  // Legend render
  renderLegend();

  // Wire form
  document.getElementById('searchForm').addEventListener('submit', (e)=>{
    e.preventDefault();
    const drugs = [
      document.getElementById('drug1').value.trim(),
      document.getElementById('drug2').value.trim(),
      document.getElementById('drug3').value.trim()
    ].filter(Boolean);
    const diluent = document.getElementById('diluent').value;

    // Must have 2 or 3
    if(drugs.length < 2){
      alert('Please enter at least two medicines.');
      return;
    }

    const hit = findMatch([drugs[0], drugs[1], drugs[2]||''], diluent);
    if(hit){
      showResultCard({
        drugs: hit.drugs,
        diluent: hit.diluent,
        classification: hit.classification,
        qualifiers: hit.qualifiers,
        reference_ids: hit.reference_ids
      });
    }else{
      showNoData([drugs[0], drugs[1], drugs[2]||''], diluent);
    }
  });

  // Set version label if your main CSV has a version row/commit date (optional)
  document.getElementById('dataVersion').textContent = new Date().toISOString().slice(0,10);
}

init();
