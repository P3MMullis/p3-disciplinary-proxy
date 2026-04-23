const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const BLANK_FORM_PATH = path.join(__dirname, 'blank_form.pdf');

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Install pypdf on startup
try {
  execSync('python3 --version', { stdio: 'ignore' });
  try {
    execSync('python3 -c "import pypdf"', { stdio: 'ignore' });
    console.log('pypdf already installed');
  } catch(e) {
    console.log('Installing pypdf...');
    execSync('pip3 install pypdf', { stdio: 'inherit' });
  }
} catch(e) {
  console.log('Python3 not available:', e.message);
}

// Claude API proxy
app.post('/api/message', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: 'API key not configured on server.' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(req.body)
    });
    const rawText = await response.text();
    let data;
    try { data = JSON.parse(rawText); } catch(e) { return res.status(500).json({ error: 'Invalid Anthropic response: ' + rawText.substring(0,200) }); }
    res.status(response.status).json(data);
  } catch(err) { res.status(500).json({ error: 'Proxy error: ' + err.message }); }
});

// PDF generation via Python/pypdf
app.post('/api/generate-pdf', async (req, res) => {
  if (!fs.existsSync(BLANK_FORM_PATH)) return res.status(500).json({ error: 'Blank form not found on server.' });

  const {
    date_form, employee_name, employee_title, employee_id,
    date_hired, department, manager_name, date_occurrence,
    location, prior_action,
    action_counseling, action_verbal, action_written, action_final,
    issue_absenteeism, issue_tardiness, issue_conduct,
    issue_safety, issue_policy, issue_performance,
    description, expectation, training, target_date
  } = req.body;

  const tmpOut = path.join(os.tmpdir(), `p3_${Date.now()}.pdf`);
  const tmpScript = path.join(os.tmpdir(), `fill_${Date.now()}.py`);

  const escStr = (s) => JSON.stringify(s || '');

  const pythonScript = `
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, create_string_object

FONT_SIZE = 11
BLANK = ${escStr(BLANK_FORM_PATH)}
OUTPUT = ${escStr(tmpOut)}

reader = PdfReader(BLANK)
writer = PdfWriter()
writer.append(reader)

text_fields = {
    'Date_Form': ${escStr(date_form)},
    'Employee_Name': ${escStr(employee_name)},
    'Employee_Title': ${escStr(employee_title)},
    'Employee_ID': ${escStr(employee_id)},
    'Date_Hired': ${escStr(date_hired)},
    'Employee_Department': ${escStr(department)},
    'Manager_Name': ${escStr(manager_name)},
    'Date_Occurrence': ${escStr(date_occurrence)},
    'Location_Occurence': ${escStr(location)},
    'Prior_Corrective_Action': ${escStr(prior_action || 'None')},
    'SpecificDescription_of_Issue': ${escStr(description)},
    'Expectation_for_Correction': ${escStr(expectation)},
    'TrainingAssigned_GoalsImprovement': ${escStr(training)},
    'TargetDate': ${escStr(target_date)},
}

checkbox_fields = {
    'CurrentAction_Counseling': ${action_counseling ? 'True' : 'False'},
    'CurrentAction_VerbalWarning': ${action_verbal ? 'True' : 'False'},
    'CurrentAction_WrittenWarning': ${action_written ? 'True' : 'False'},
    'CurrentAction_FinalWarning': ${action_final ? 'True' : 'False'},
    'GeneralIssue_Absenteeism': ${issue_absenteeism ? 'True' : 'False'},
    'GeneralIssue_Tardiness': ${issue_tardiness ? 'True' : 'False'},
    'GeneralIssue_Conduct': ${issue_conduct ? 'True' : 'False'},
    'GeneralIssue_SafetyViolation': ${issue_safety ? 'True' : 'False'},
    'GeneralIssue_PolicyViolation': ${issue_policy ? 'True' : 'False'},
    'GeneralIssue_WorkplacePerformance': ${issue_performance ? 'True' : 'False'},
}

# Set font size on all text fields before filling
for page in writer.pages:
    if '/Annots' in page:
        for annot in page['/Annots']:
            obj = annot.get_object()
            field_name = obj.get('/T')
            if field_name in text_fields:
                obj.update({NameObject('/DA'): create_string_object(f'/Helv {FONT_SIZE} Tf 0 g')})

# Fill text fields
for page in writer.pages:
    writer.update_page_form_field_values(page, text_fields, auto_regenerate=True)

# Fill checkboxes
for page in writer.pages:
    if '/Annots' in page:
        for annot in page['/Annots']:
            obj = annot.get_object()
            field_name = obj.get('/T')
            if field_name in checkbox_fields:
                if checkbox_fields[field_name]:
                    obj.update({NameObject('/V'): NameObject('/Yes'), NameObject('/AS'): NameObject('/Yes')})
                else:
                    obj.update({NameObject('/V'): NameObject('/Off'), NameObject('/AS'): NameObject('/Off')})

with open(OUTPUT, 'wb') as f:
    writer.write(f)

print('ok')
`;

  try {
    fs.writeFileSync(tmpScript, pythonScript);
    const result = spawnSync('python3', [tmpScript], { timeout: 30000, encoding: 'utf8' });

    if (result.error) throw new Error(result.error.message);
    if (result.status !== 0) throw new Error(result.stderr || 'Python script failed');

    fs.unlinkSync(tmpScript);
    const pdfBuffer = fs.readFileSync(tmpOut);
    fs.unlinkSync(tmpOut);

    const safeName = (employee_name || 'form').replace(/\s+/g, '_');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="P3_Disciplinary_${safeName}.pdf"`,
      'Content-Length': pdfBuffer.length
    });
    res.send(pdfBuffer);

  } catch(err) {
    console.error('PDF error:', err.message);
    if (fs.existsSync(tmpScript)) fs.unlinkSync(tmpScript);
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
    res.status(500).json({ error: 'PDF generation failed: ' + err.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'P3 Services API Proxy is running.', apiKeySet: !!API_KEY, formReady: fs.existsSync(BLANK_FORM_PATH) });
});

app.listen(PORT, () => {
  console.log('Proxy running on port ' + PORT);
  console.log('API Key set:', !!API_KEY);
  console.log('Blank form exists:', fs.existsSync(BLANK_FORM_PATH));
});
