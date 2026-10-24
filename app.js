
/* =======================
   CONFIG
======================= */
const DATA = {
  main: 'data/Website_DataSet.csv',
  refs: 'data/reference.csv',
  classLegend: 'data/classification_legend.csv',
  qualLegend: 'data/qualifier_legend.csv',
  advice: 'data/specific_advice.json',
  classes: 'data/drug_classes.csv'
};

const GOOGLE_FORM = {
  enabled: false,
  action: 'PASTE_YOUR_GOOGLE_FORM_formResponse_URL_HERE',
  fields: {
    combo_drug_1: 'entry.DRUG1',
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

// Local storage is for prototype testing only.
const BACKEND = {
  mode: 'local',
  webhookUrl: ''
};

const ReportStore = (() => {
  const KEY = 'syringe_observations_csv_rows_v1';

  const read = () => {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  };

  const write = rows => {
    localStorage.setItem(KEY, JSON.stringify(rows));
  };

  const appendRow = rowObj => {
    const rows = read();
    rows.push(rowObj);
    write(rows);
  };

  const clear = () => write([]);

  const toCSV = () => {
    const rows = read();
    if (!rows.length) return 'No rows';

    const headers = [...new Set(
      rows.flatMap(row => Object.keys(row))
    )];

    const esc = value => {
      const s = String(value ?? '');
      return /[",\n]/.test(s)
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };

    return [
      headers.map(esc).join(','),
      ...rows.map(row =>
        headers.map(h => esc(row[h])).join(',')
      )
    ].join('\n');
  };

  const downloadCSV = () => {
    const blob = new Blob([toCSV()], {
      type: 'text/csv;charset=utf-8;'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    a.href = url;
    a.download =
      `syringe-observations_${new Date()
        .toISOString().slice(0, 10)}.csv`;

    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return {
    read, appendRow, clear, toCSV, downloadCSV
  };
})();

// Prototype-only local administration controls.
// This is NOT secure authentication.
(function injectAdminBarIfNeeded() {
  const params = new URLSearchParams(location.search);
  if (params.get('admin') !== '1') return;

  const bar = document.createElement('div');
  bar.className = 'prototype-admin';

  bar.innerHTML = `
    <strong>Local prototype admin tools</strong>
    <button type="button" id="admin-download">
      Download local reports
    </button>
    <button type="button" id="admin-clear">
      Clear local reports
    </button>
  `;

  document.body.appendChild(bar);

  bar.querySelector('#admin-download')
    .addEventListener('click', () => {
      ReportStore.downloadCSV();
    });

  bar.querySelector('#admin-clear')
    .addEventListener('click', () => {
      if (confirm('Clear locally stored reports?')) {
        ReportStore.clear();
      }
    });
})();

/* =======================
   CSV PARSER
======================= */
function parseCSV(text) {
  const rows = [];
  let i = 0;
  let field = '';
  let row = [];
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };

  const pushRow = () => {
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }

      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\n') {
      pushField();
      pushRow();
    } else if (c !== '\r') {
      field += c;
    }

    i++;
  }

  if (field.length || row.length) {
    pushField();
    pushRow();
  }

  return rows;
}

async function loadCSV(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Unable to load ${url}`);
  }

  const text = await response.text();
  const rows = parseCSV(text).filter(
    row => row.length && row.join('').trim()
  );

  if (!rows.length) {
    throw new Error(`Empty CSV: ${url}`);
  }

  const headers = rows[0].map(h => h.trim());

  return {
    headers,
    rows: rows.slice(1).map(row => {
      const obj = {};
      headers.forEach((h, index) => {
        obj[h] = String(row[index] ?? '').trim();
      });
      return obj;
    })
  };
}


/* =======================
   HELPERS AND STATE
======================= */

const norm = value => String(value ?? '')
  .trim()
  .toLowerCase()
  .replace(/\s+/g, ' ');

const uniq = values => [...new Set(values)];

const nonEmpty = value =>
  String(value ?? '').trim().length > 0;

const escapeHtml = value =>
  String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));

// Existing classification precedence.
const precedence = {
  '3': 6,
  '5': 5,
  '2': 4,
  '7': 3,
  '6': 2,
  '1': 1
};

const classificationLabels = new Map();
const qualifierLabels = new Map();
const refsMap = new Map();

let dataset = [];
let classMap = new Map();
let specificAdvice = {};

// Medicine names and aliases used for matching.
const MEDICINE_ALIASES = {
  'furosemide': 'furosemide',
  'frusemide': 'furosemide',
  'lidocaine': 'lidocaine',
  'lignocaine': 'lidocaine',
  'lidocaine (lignocaine)': 'lidocaine',
  'proton pump inhibitor': 'proton pump inhibitor',
  'proton pump inhibitors': 'proton pump inhibitor'
};

function canonicalMedicine(name) {
  const key = norm(name);
  return MEDICINE_ALIASES[key] || key;
}

// These medicines display advice only.
// They cannot be combined with other medicines
// in the prototype search.
const ADVICE_ONLY_MEDICINES = [
  'dexmedetomidine',
  'famotidine',
  'ranitidine',
  'furosemide',
  'lidocaine',
  'phenobarbital',
  'proton pump inhibitor',
  'sodium valproate',
  'dexamethasone',
  'olanzapine',
  'parecoxib'
];

const adviceOnlySet = new Set(
  ADVICE_ONLY_MEDICINES.map(canonicalMedicine)
);

// Levetiracetam remains searchable.
// Its advice appears only after Search.
const SEARCHABLE_ADVICE_MEDICINES = new Set([
  'levetiracetam'
]);

function isAdviceOnly(name) {
  return adviceOnlySet.has(canonicalMedicine(name));
}

function hasSearchAdvice(name) {
  return SEARCHABLE_ADVICE_MEDICINES.has(
    canonicalMedicine(name)
  );
}

/* =======================
   USER INTERFACE REFERENCES
======================= */

const drug1Sel = document.getElementById('drug1');
const drug2Sel = document.getElementById('drug2');
const drug3Sel = document.getElementById('drug3');

const resultsEl = document.getElementById('results');
const searchForm = document.getElementById('searchForm');

// These containers will be created automatically
// if they do not exist in index.html.

function ensureElement(id, tag = 'div', before = null) {
  let element = document.getElementById(id);

  if (!element) {
    element = document.createElement(tag);
    element.id = id;

    if (before?.parentNode) {
      before.parentNode.insertBefore(element, before);
    } else {
      searchForm.parentNode.appendChild(element);
    }
  }

  return element;
}

const adviceEl = ensureElement(
  'specificAdvice',
  'section',
  resultsEl
);

const searchMessageEl = ensureElement(
  'searchMessage',
  'div',
  resultsEl
);

adviceEl.setAttribute('aria-live', 'polite');
searchMessageEl.setAttribute('role', 'status');
resultsEl.setAttribute('aria-live', 'polite');

/* =======================
   MEDICINE OPTIONS
======================= */

function setOptions(selectEl, values) {
  const previousValue = selectEl.value;

  selectEl.innerHTML = '';

  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '— Select medicine —';
  selectEl.appendChild(blank);

  values.forEach(name => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    selectEl.appendChild(option);
  });

  if (values.includes(previousValue)) {
    selectEl.value = previousValue;
  }
}

function buildDrugOptions() {
  const names = [];

  dataset.forEach(record => {
    [
      record.raw.drug_1,
      record.raw.drug_2,
      record.raw.drug_3
    ].forEach(name => {
      if (nonEmpty(name)) names.push(name);
    });
  });

  // Additional medicines available in Medicine 1,
  // even when no compatibility combinations exist.
  const adviceNames = [
    'Dexmedetomidine',
    'Famotidine',
    'Ranitidine',
    'Furosemide',
    'Lidocaine',
    'Phenobarbital',
    'Proton pump inhibitor',
    'Sodium valproate',
    'Dexamethasone',
    'Olanzapine',
    'Parecoxib'
  ];

  const seen = new Set();
  const allNames = [];

  [...names, ...adviceNames].forEach(name => {
    const key = canonicalMedicine(name);

    if (!seen.has(key)) {
      seen.add(key);
      allNames.push(name);
    }
  });

  allNames.sort((a, b) =>
    a.localeCompare(b, undefined, {
      sensitivity: 'base'
    })
  );

  // Medicine 1 includes all medicines.
  setOptions(drug1Sel, allNames);

  // Medicine 2 and 3 exclude advice-only medicines.
  const searchableNames = allNames.filter(
    name => !isAdviceOnly(name)
  );

  setOptions(drug2Sel, searchableNames);
  setOptions(drug3Sel, searchableNames);
}

/* =======================
   COMBINATION MATCHING
======================= */

// Medicine order does not affect matching.
function keyFor(drugs) {
  return drugs
    .map(norm)
    .filter(Boolean)
    .sort()
    .join(' | ');
}

function findMatches(drugs) {
  const key = keyFor(drugs);
  return dataset.filter(record => record.key === key);
}

/* =======================
   SAME-CLASS RULE
======================= */

// Preserve the existing SCV same-class restriction.
const FLAG_CLASSES = new Set([
  'Opioid',
  'Dopamine antagonist'
]);

function sharedFlagClass(drugs) {
  const counts = {};

  drugs.forEach(drug => {
    const cls = classMap.get(norm(drug));
    if (!cls) return;

    counts[cls] = (counts[cls] || 0) + 1;
  });

  for (const cls of Object.keys(counts)) {
    if (
      FLAG_CLASSES.has(cls) &&
      counts[cls] >= 2
    ) {
      return cls;
    }
  }

  return null;
}

/* =======================
   SUMMARISE BY DILUENT
======================= */

function summariseByDiluent(records) {
  const grouped = new Map();

  records.forEach(record => {
    const diluent = record.diluent;

    if (!grouped.has(diluent)) {
      grouped.set(diluent, []);
    }

    grouped.get(diluent).push(record);
  });

  const summaries = [];

  grouped.forEach((rows, diluent) => {
    const classifications = rows
      .map(row => String(row.classification).trim())
      .filter(Boolean);

    const classification = classifications.sort(
      (a, b) =>
        (precedence[b] || 0) -
        (precedence[a] || 0)
    )[0] || '';

    const qualifiers = uniq(
      rows.flatMap(row =>
        String(row.qualifiers || '')
          .split(/[\s,|]+/)
          .filter(Boolean)
      )
    );

    const references = uniq(
      rows.flatMap(row =>
        String(row.reference_ids || '')
          .split(',')
          .map(id => id.trim())
          .filter(Boolean)
      )
    );

    summaries.push({
      diluent,
      classification,
      qualifiers,
      references
    });
  });

  // Preserve preferred diluent ordering.
  summaries.sort((a, b) => {
    const score = name => {
      if (name === 'Water for injection') return 0;
      if (name === 'Sodium chloride 0.9%') return 1;
      return 2;
    };

    return score(a.diluent) - score(b.diluent);
  });

  return summaries;
}

/* =======================
   MEDICINE-SPECIFIC ADVICE
======================= */

function getMedicineAdvice(name) {
  const key = canonicalMedicine(name);

  if (!key) return null;

  // Supports either a JSON object keyed by medicine
  // or an array containing medicine objects.
  if (Array.isArray(specificAdvice)) {
    return specificAdvice.find(item =>
      canonicalMedicine(
        item.medicine || item.name || item.drug
      ) === key
    ) || null;
  }

  for (const [nameKey, item] of
    Object.entries(specificAdvice)) {

    if (canonicalMedicine(nameKey) === key) {
      return item;
    }
  }

  return null;
}

function renderSpecificAdvice(medicine) {
  adviceEl.innerHTML = '';

  const advice = getMedicineAdvice(medicine);

  if (!advice) {
    adviceEl.innerHTML = `
      <div class="panel">
        <h3>Specific administration advice</h3>
        <p>
          Guidance for ${escapeHtml(medicine)}
          is not available in the loaded advice file.
        </p>
      </div>
    `;
    return;
  }

  const heading =
    advice.heading ||
    advice.title ||
    advice.category ||
    'Specific administration advice';

const description =
  advice.points ||
  advice.description ||
  advice.text ||
  advice.advice ||
  '';

  const paragraphs = Array.isArray(description)
    ? description
    : [description];

const adviceHtml = Array.isArray(description)
  ? `<ul class="advice-points">
      ${description
        .filter(Boolean)
        .map(text => `<li>${escapeHtml(text)}</li>`)
        .join('')}
     </ul>`
  : description
    ? `<p>${escapeHtml(description)}</p>`
    : '';

  const references = advice.references
  ? [advice.references]
  : [];

  const referencesHtml = Array.isArray(references)
    ? references.map(ref =>
        `<li>${escapeHtml(ref)}</li>`
      ).join('')
    : `<li>${escapeHtml(references)}</li>`;

  adviceEl.innerHTML = `
    <section class="panel specific-advice-panel">
      <h3>${escapeHtml(heading)}</h3>
      <h4>${escapeHtml(medicine)}</h4>

      ${adviceHtml}

      ${referencesHtml
        ? `<div class="section-title">References</div>
           <ul class="refs">${referencesHtml}</ul>`
        : ''}
    </section>
  `;
}

function clearSpecificAdvice() {
  adviceEl.innerHTML = '';
}

/* =======================
   MEDICINE SELECTION LOGIC
======================= */

function setSearchMessage(message) {
  searchMessageEl.textContent = message || '';
}

function clearResults() {
  resultsEl.innerHTML = '';
  clearSpecificAdvice();
  setSearchMessage('');
}

function updateMedicineSelection() {
  const medicine1 = drug1Sel.value;

  clearResults();

  // Find the existing labels wrapping Medicine 2
  // and Medicine 3.
  const medicine2Field = drug2Sel.closest('label');
  const medicine3Field = drug3Sel.closest('label');

  if (!medicine1) {
    if (medicine2Field) medicine2Field.hidden = false;
    if (medicine3Field) medicine3Field.hidden = false;

    drug2Sel.disabled = false;
    drug3Sel.disabled = false;
    return;
  }

  if (isAdviceOnly(medicine1)) {
    // Clear previously selected combinations.
    drug2Sel.value = '';
    drug3Sel.value = '';

    drug2Sel.disabled = true;
    drug3Sel.disabled = true;

    if (medicine2Field) medicine2Field.hidden = true;
    if (medicine3Field) medicine3Field.hidden = true;

    // Advice appears immediately.
    renderSpecificAdvice(medicine1);

    setSearchMessage(
      'Specific administration advice is displayed. ' +
      'Combination searching is unavailable for this medicine.'
    );

    return;
  }

  // Standard medicines and levetiracetam.
  drug2Sel.disabled = false;
  drug3Sel.disabled = false;

  if (medicine2Field) medicine2Field.hidden = false;
  if (medicine3Field) medicine3Field.hidden = false;

  // Levetiracetam advice deliberately does not
  // appear until Search is pressed.
}

drug1Sel.addEventListener(
  'change',
  updateMedicineSelection
);

drug2Sel.addEventListener('change', () => {
  resultsEl.innerHTML = '';
  if (!isAdviceOnly(drug1Sel.value)) {
    clearSpecificAdvice();
  }
});

drug3Sel.addEventListener('change', () => {
  resultsEl.innerHTML = '';
  if (!isAdviceOnly(drug1Sel.value)) {
    clearSpecificAdvice();
  }
});


/* =======================
   SECTION 3
   RESULTS AND OBSERVATIONS
======================= */

/* =======================
   RESULT DISPLAY HELPERS
======================= */

function clsBadge(code) {
  return `badge c${code}`;
}

function refsHtml(refIds) {
  if (!refIds.length) return '';

  const items = refIds.map(id => {
    const reference =
      refsMap.get(id) || `Reference ${id}`;

    return `
      <li>
        ${escapeHtml(id)}.
        ${escapeHtml(reference)}
      </li>
    `;
  }).join('');

  return `
    <div class="section-title">References</div>
    <ul class="refs">${items}</ul>
  `;
}

function qualsHtml(qualCodes) {
  if (!qualCodes.length) return '';

  const items = qualCodes.map(code => {
    const description =
      qualifierLabels.get(code) || code;

    return `
      <span class="qual">
        ${escapeHtml(description)}
      </span>
    `;
  }).join('');

  return `
    <div class="section-title">Qualifiers</div>
    <div class="qualifiers">${items}</div>
  `;
}

/* =======================
   RENDER COMPATIBILITY RESULTS
======================= */

function renderResult(drugs, summaries) {
  resultsEl.innerHTML = '';

  const combination = drugs
    .filter(Boolean)
    .join(' + ');

  // No published compatibility data.
  if (!summaries.length) {
    const wrap = document.createElement('section');
    wrap.className = 'result';

    wrap.innerHTML = `
      <h3>${escapeHtml(combination)}</h3>

      <div class="badges">
        <span class="badge c4">No data</span>
      </div>

      <p>
        No published compatibility data were found
        for this combination.
      </p>

      <p class="meta">
        Consider separate infusions and seek
        specialist advice.
      </p>
    `;

    resultsEl.appendChild(wrap);

    renderObservationPanel(
      drugs,
      true,
      false
    );

    return;
  }

  let anyAnecdotal = false;

  summaries.forEach(summary => {
    const code = String(
      summary.classification || ''
    );

    const classification =
      classificationLabels.get(code) || {
        label: 'Classification unavailable',
        description: ''
      };

    if (code === '1') {
      anyAnecdotal = true;
    }

    const wrap = document.createElement('section');
    wrap.className = 'result';

    wrap.innerHTML = `
      <h3>${escapeHtml(combination)}</h3>

      <div class="badges">
        <span class="badge diluent">
          ${escapeHtml(summary.diluent)}
        </span>

        <span class="${clsBadge(code)}">
          ${escapeHtml(classification.label)}
        </span>
      </div>

      <p class="meta">
        ${escapeHtml(classification.description)}
      </p>

      ${qualsHtml(summary.qualifiers)}

      ${refsHtml(summary.references)}
    `;

    resultsEl.appendChild(wrap);
  });

  // Registry is only shown for classification 1.
  if (anyAnecdotal) {
    renderObservationPanel(
      drugs,
      false,
      true
    );
  }
}

/* =======================
   OBSERVATIONAL REGISTRY
======================= */

function renderObservationPanel(
  drugs,
  noData,
  anecdotal
) {
  const panel = document.createElement('section');
  panel.className = 'panel obs';

  const heading = document.createElement('h3');
  heading.textContent = 'Clinical experience report';

  panel.appendChild(heading);

  const introduction = document.createElement('p');

  introduction.textContent =
    'Safer Care Victoria is collecting information ' +
    'about medicine combinations used in clinical ' +
    'practice to help inform future compatibility ' +
    'research. Do not include patient-identifiable ' +
    'information.';

  panel.appendChild(introduction);

  const form = document.createElement('form');
  form.className = 'observation-form';
  form.noValidate = true;

  panel.appendChild(form);

  /* =======================
     QUESTION BUILDERS
  ======================= */

  function buildRadioQuestion(
    id,
    question,
    options,
    required = true
  ) {
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'observation-question';

    const legend = document.createElement('legend');
    legend.textContent = question;

    fieldset.appendChild(legend);

    options.forEach((option, index) => {
      const label = document.createElement('label');
      label.className = 'radio-option';

      const input = document.createElement('input');
      input.type = 'radio';
      input.name = id;
      input.value = option.value;
      input.required = required && index === 0;

      const text = document.createElement('span');
      text.textContent = option.label;

      label.appendChild(input);
      label.appendChild(text);

      fieldset.appendChild(label);
    });

    return fieldset;
  }

  function buildSelectQuestion(
    id,
    question,
    options
  ) {
    const label = document.createElement('label');
    label.className = 'observation-question';

    const text = document.createElement('span');
    text.textContent = question;

    const select = document.createElement('select');
    select.name = id;
    select.required = true;

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Please select';

    select.appendChild(placeholder);

    options.forEach(option => {
      const opt = document.createElement('option');

      if (typeof option === 'string') {
        opt.value = option;
        opt.textContent = option;
      } else {
        opt.value = option.value;
        opt.textContent = option.label;
      }

      select.appendChild(opt);
    });

    label.appendChild(text);
    label.appendChild(select);

    return label;
  }

  /* =======================
     QUESTION 1
  ======================= */

  const q1 = buildRadioQuestion(
    'usage_duration',
    '1. Has this combination been used in clinical practice?',
    [
      {
        label:
          'Yes — administered for more than 24 hours',
        value: 'more_than_24h'
      },
      {
        label:
          'Yes — administered for 24 hours or less',
        value: '24h_or_less'
      },
      {
        label: 'No',
        value: 'not_used'
      }
    ]
  );

  form.appendChild(q1);

  /* =======================
     FOLLOW-UP QUESTIONS
  ======================= */

  const followUp = document.createElement('div');
  followUp.className = 'observation-followup';
  followUp.hidden = true;

  // For no-data combinations, collect observations.
  if (noData) {
    followUp.appendChild(
      buildRadioQuestion(
        'appeared_compatible',
        '2. Did the combination appear physically compatible?',
        [
          {
            label: 'Yes',
            value: 'Yes'
          },
          {
            label: 'No',
            value: 'No'
          },
          {
            label: 'Unable to determine',
            value: 'Unable to determine'
          }
        ]
      )
    );

    followUp.appendChild(
      buildSelectQuestion(
        'change_frequency',
        '3. How frequently was the infusion changed?',
        [
          {
            label: 'Every 24 hours',
            value: '24'
          },
          {
            label: 'Every 48 hours',
            value: '48'
          },
          {
            label: 'More than 48 hours',
            value: '>48'
          },
          {
            label: 'Unsure',
            value: 'Unsure'
          }
        ]
      )
    );

    followUp.appendChild(
      buildSelectQuestion(
        'diluent_used',
        '4. What diluent was used?',
        [
          'Water for injection',
          'Sodium chloride 0.9%',
          'No diluent',
          'Other',
          'Unsure'
        ]
      )
    );

    followUp.appendChild(
      buildRadioQuestion(
        'reaction_observed',
        '5. Were any infusion-site reactions observed?',
        [
          {
            label: 'Yes',
            value: 'Yes'
          },
          {
            label: 'No',
            value: 'No'
          },
          {
            label: 'Unsure',
            value: 'Unsure'
          }
        ]
      )
    );
  }

  // For classification 1, only Q1 is required.
  // No further questions are currently collected.

  form.appendChild(followUp);

  /* =======================
     SUBMISSION CONTROLS
  ======================= */

  const confirmation = document.createElement('p');
  confirmation.className = 'confirm-text';

  confirmation.textContent =
    'Please submit observational information only. ' +
    'Do not include patient-identifiable information. ' +
    'An observation of physical compatibility does not ' +
    'establish chemical stability.';

  form.appendChild(confirmation);

  const errorMessage = document.createElement('p');
  errorMessage.className = 'form-error';
  errorMessage.setAttribute('role', 'alert');
  errorMessage.hidden = true;

  form.appendChild(errorMessage);

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'btn';
  submitButton.textContent = 'Submit report';
  submitButton.disabled = true;

  form.appendChild(submitButton);

  resultsEl.appendChild(panel);

  /* =======================
     BRANCHING
  ======================= */

  function getValue(name) {
    const checked = form.querySelector(
      `input[name="${name}"]:checked`
    );

    if (checked) return checked.value;

    const select = form.querySelector(
      `select[name="${name}"]`
    );

    return select ? select.value : '';
  }

  function updateObservationForm() {
    const usage = getValue('usage_duration');

    const usedInPractice =
      usage === 'more_than_24h' ||
      usage === '24h_or_less';

    // Follow-up only applies to no-data results
    // where the combination has been used.
    followUp.hidden = !(noData && usedInPractice);

    const fields = followUp.querySelectorAll(
      'input, select'
    );

    fields.forEach(field => {
      field.disabled = followUp.hidden;
    });

    let complete = Boolean(usage);

    if (noData && usedInPractice) {
      complete =
        complete &&
        Boolean(getValue('appeared_compatible')) &&
        Boolean(getValue('change_frequency')) &&
        Boolean(getValue('diluent_used')) &&
        Boolean(getValue('reaction_observed'));
    }

    submitButton.disabled = !complete;
    errorMessage.hidden = true;
  }

  form.addEventListener(
    'change',
    updateObservationForm
  );

  updateObservationForm();

  /* =======================
     BUILD REPORT
  ======================= */

  function buildReport() {
    const usage = getValue('usage_duration');

    const [d1, d2, d3] = [
      drugs[0] || '',
      drugs[1] || '',
      drugs[2] || ''
    ];

    const report = {
      datetime_iso: new Date().toISOString(),

      drug_1: d1,
      drug_2: d2,
      drug_3: d3,

      classification_at_search:
        noData
          ? 'No data'
          : anecdotal
            ? 'Appears compatible (anecdotal)'
            : 'Other',

      used_in_practice:
        usage === 'not_used' ? 'No' : 'Yes',

      usage_duration: usage,

      administered_more_than_24h:
        usage === 'more_than_24h'
          ? 'Yes'
          : usage === '24h_or_less'
            ? 'No'
            : ''
    };

    if (noData && usage !== 'not_used') {
      report.appeared_compatible =
        getValue('appeared_compatible');

      report.change_frequency_hours =
        getValue('change_frequency');

      report.diluent_used =
        getValue('diluent_used');

      report.reaction_observed =
        getValue('reaction_observed');
    }

    return report;
  }

  /* =======================
     SUBMISSION
  ======================= */

  async function saveReport(report) {
    if (BACKEND.mode === 'local') {
      ReportStore.appendRow(report);
      return;
    }

    if (BACKEND.mode === 'webhook') {
      if (!BACKEND.webhookUrl) {
        throw new Error('Webhook URL not configured');
      }

      const response = await fetch(
        BACKEND.webhookUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(report)
        }
      );

      if (!response.ok) {
        throw new Error(
          `Report submission failed: ${response.status}`
        );
      }

      return;
    }

    if (BACKEND.mode === 'form') {
      throw new Error(
        'Google Forms submission requires configuration.'
      );
    }

    throw new Error('Unknown reporting mode');
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();

    updateObservationForm();

    if (submitButton.disabled) {
      errorMessage.textContent =
        'Please complete all required questions.';
      errorMessage.hidden = false;
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Submitting…';

    try {
      const report = buildReport();

      await saveReport(report);

      panel.innerHTML = `
        <div class="thankyou" role="status">
          <h3>Thank you for your report</h3>
          <p>
            Your observational report has been
            recorded in this prototype.
          </p>
        </div>
      `;
    } catch (error) {
      console.error(error);

      errorMessage.textContent =
        'There was a problem saving your report. ' +
        'Please try again.';

      errorMessage.hidden = false;

      submitButton.disabled = false;
      submitButton.textContent = 'Submit report';
    }
  });
}

/* =======================
   SECTION 4
   APPLICATION INITIALISATION
======================= */

/* =======================
   SEARCH CONTROLS
======================= */

function updateSearchButton() {
  const medicine1 = drug1Sel.value;
  const medicine2 = drug2Sel.value;

  const searchButton = searchForm.querySelector(
    'button[type="submit"]'
  );

  if (!searchButton) return;

  // Advice-only medicines do not require Search.
  if (isAdviceOnly(medicine1)) {
    searchButton.hidden = true;
    searchButton.disabled = true;
    return;
  }

  searchButton.hidden = false;
  searchButton.disabled = false;

  // Allow the button to remain visible while
  // selecting medicines. Native validation will
  // require Medicine 1 and Medicine 2.
}

/* =======================
   MEDICINE SELECTION EVENTS
======================= */

function initialiseMedicineEvents() {
  drug1Sel.addEventListener('change', () => {
    updateSearchButton();
  });

  drug2Sel.addEventListener('change', () => {
    updateSearchButton();
  });

  drug3Sel.addEventListener('change', () => {
    updateSearchButton();
  });
}

/* =======================
   SEARCH VALIDATION
======================= */

function validateSearch(drugs) {
  const selected = drugs.filter(Boolean);

  if (selected.length < 2) {
    return 'Please select at least two medicines.';
  }

  // Prevent selecting the same medicine twice.
  const normalised = selected.map(canonicalMedicine);

  if (new Set(normalised).size !== normalised.length) {
    return 'Please select different medicines.';
  }

  // Advice-only medicines cannot form combinations.
  if (selected.some(isAdviceOnly)) {
    return (
      'Combination searching is unavailable for ' +
      'the selected medicine.'
    );
  }

  return '';
}

/* =======================
   SEARCH EXECUTION
======================= */

function performCompatibilitySearch(event) {
  event.preventDefault();

  const medicine1 = drug1Sel.value;
  const medicine2 = drug2Sel.value;
  const medicine3 = drug3Sel.value;

  clearResults();

  // Advice-only medicines display guidance
  // immediately without a compatibility search.
  if (isAdviceOnly(medicine1)) {
    renderSpecificAdvice(medicine1);

    setSearchMessage(
      'Specific administration advice is displayed. ' +
      'Combination searching is unavailable.'
    );

    return;
  }

  const selectedDrugs = [
    medicine1,
    medicine2,
    medicine3
  ].filter(Boolean);

  const validationError =
    validateSearch(selectedDrugs);

  if (validationError) {
    setSearchMessage(validationError);
    return;
  }

  // Preserve the existing same-class rule.
  // Classification 5 takes precedence over
  // dataset compatibility results.
  const classHit = sharedFlagClass(selectedDrugs);

  if (classHit) {
    const summaries = [{
      diluent: '—',
      classification: '5',
      qualifiers: [],
      references: []
    }];

    renderResult(selectedDrugs, summaries);

  } else {
    // Find matching combinations in the dataset.
    const matches = findMatches(selectedDrugs);

    const summaries = summariseByDiluent(matches);

    renderResult(selectedDrugs, summaries);
  }

  // Levetiracetam advice appears ONLY after Search.
  if (selectedDrugs.some(hasSearchAdvice)) {
    const adviceMedicine = selectedDrugs.find(
      hasSearchAdvice
    );

    renderSpecificAdvice(adviceMedicine);
  }

  setSearchMessage(
    'Compatibility search completed.'
  );
}

/* =======================
   LOAD MEDICINE-SPECIFIC ADVICE
======================= */

async function loadSpecificAdvice() {
  const response = await fetch(DATA.advice);

  if (!response.ok) {
    throw new Error(
      `Unable to load medicine advice: ${DATA.advice}`
    );
  }

  specificAdvice = await response.json();
}

/* =======================
   LOAD CLASSIFICATION LEGENDS
======================= */

async function loadLegends() {
  const [classification, qualifiers] =
    await Promise.all([
      loadCSV(DATA.classLegend),
      loadCSV(DATA.qualLegend)
    ]);

  classification.rows.forEach(row => {
    classificationLabels.set(
      String(row.id || '').trim(),
      {
        label: row.label || '',
        description: row.description || ''
      }
    );
  });

  qualifiers.rows.forEach(row => {
    qualifierLabels.set(
      String(row.code || '').trim(),
      row.description || ''
    );
  });
}

/* =======================
   LOAD REFERENCES
======================= */

async function loadReferences() {
  const { rows } = await loadCSV(DATA.refs);

  rows.forEach(row => {
    if (!row.id) return;

    refsMap.set(
      String(row.id).trim(),
      String(row.full_reference || '').trim()
    );
  });
}

/* =======================
   LOAD MEDICINE CLASSES
======================= */

async function loadMedicineClasses() {
  const { rows } = await loadCSV(DATA.classes);

  rows.forEach(row => {
    const name = norm(row.drug_name);
    const medicineClass = String(
      row.class || ''
    ).trim();

    if (name && medicineClass) {
      classMap.set(name, medicineClass);
    }
  });
}

/* =======================
   LOAD COMPATIBILITY DATASET
======================= */

async function loadCompatibilityDataset() {
  const { rows } = await loadCSV(DATA.main);

  dataset = rows
    // Ranitidine records should already have
    // been removed from the CSV.
    // This additional filter is a safeguard.
    .filter(row => {
      const medicines = [
        row.drug_1,
        row.drug_2,
        row.drug_3
      ];

      return !medicines.some(
        medicine =>
          canonicalMedicine(medicine) ===
          'ranitidine'
      );
    })

    .map(row => {
      const drugs = [
        row.drug_1 || '',
        row.drug_2 || '',
        row.drug_3 || ''
      ];

      return {
        raw: row,

        key: keyFor(drugs),

        drugs: drugs.filter(Boolean),

        diluent: row.diluent || '',

        classification: String(
          row.classification || ''
        ).trim(),

        qualifiers: String(
          row.qualifiers || ''
        ).trim(),

        reference_ids: String(
          row.reference_ids || ''
        ).trim()
      };
    });
}

/* =======================
   APPLICATION VERSION
======================= */

function updateVersion() {
  const versionElement =
    document.getElementById('dataVersion');

  if (versionElement) {
    versionElement.textContent =
      'Prototype v2 — October 2026';
  }
}

/* =======================
   INITIALISE APPLICATION
======================= */

async function init() {
  try {
    setSearchMessage('Loading compatibility data…');

    // Load clinical information and references.
    await Promise.all([
      loadLegends(),
      loadReferences(),
      loadMedicineClasses(),
      loadSpecificAdvice(),
      loadCompatibilityDataset()
    ]);

    // Populate medicine dropdowns.
    buildDrugOptions();

    // Initialise selection behaviour.
    initialiseMedicineEvents();

    // Set the initial search button state.
    updateSearchButton();

    // Connect Search button.
    searchForm.addEventListener(
      'submit',
      performCompatibilitySearch
    );

    // Display application version.
    updateVersion();

    setSearchMessage('');

  } catch (error) {
    console.error(
      'Application initialisation failed:',
      error
    );

    setSearchMessage(
      'Unable to load the compatibility data. ' +
      'Please refresh the page or contact the ' +
      'application administrator.'
    );

    const searchButton = searchForm.querySelector(
      'button[type="submit"]'
    );

    if (searchButton) {
      searchButton.disabled = true;
    }
  }
}

/* =======================
   START APPLICATION
======================= */

init();
