const express = require('express');
const cors = require('cors');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Install pypdf if not present
try {
  execSync('python3 -c "import pypdf"', { stdio: 'ignore' });
} catch(e) {
  console.log('Installing pypdf...');
  execSync('pip3 install pypdf --break-system-packages -q', { stdio: 'inherit' });
}

// Base64 encoded blank P3 form - loaded from file
const BLANK_FORM_PATH = path.join(__dirname, 'blank_form.pdf');

// Claude API proxy
app.post('/api/message', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'API key not configured on server.' });
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const rawText = await response.text();
    let data;
    try { data = JSON.parse(rawText); }
    catch(e) { return res.status(500).json({ error: 'Invalid response from Anthropic: ' + rawText.substring(0,200) }); }
    res.status(response.status).json(data);
  } catch(err) {
    res.status(500).json({ error: 'Proxy error: ' + err.message });
  }
});

// PDF generation endpoint
app.post('/api/generate-pdf', async (req, res) => {
  if (!fs.existsSync(BLANK_FORM_PATH)) {
    return res.status(500).json({ error: 'Blank form not found on server.' });
  }

  const {
    date_form, employee_name, employee_title, employee_id,
    date_hired, department, manager_name, date_occurrence,
    location, prior_action, is_ongoing,
    ongoing_start, ongoing_end,
    action_counseling, action_verbal, action_written, action_final,
    issue_absenteeism, issue_tardiness, issue_conduct,
    issue_safety, issue_policy, issue_performance,
    description, expectation, training, target_date
  } = req.body;

  const tmpOut = path.join(os.tmpdir(), `p3_form_${Date.now()}.pdf`);

  const pythonScript = `
import sys
from pypdf import PdfReader, PdfWriter

reader = PdfReader(${JSON.stringify(BLANK_FORM_PATH)})
writer = PdfWriter()
writer.append(reader)

fields = {
    'Date_Form': ${JSON.stringify(date_form || '')},
    'Employee_Name': ${JSON.stringify(employee_name || '')},
    'Employee_Title': ${JSON.stringify(employee_title || '')},
    'Employee_ID': ${JSON.stringify(employee_id || '')},
    'Date_Hired': ${JSON.stringify(date_hired || '')},
    'Employee_Department': ${JSON.stringify(department || '')},
    'Manager_Name': ${JSON.stringify(manager_name || '')},
    'Date_Occurrence': ${JSON.stringify(date_occurrence || '')},
    'Location_Occurence': ${JSON.stringify(location || '')},
    'Prior_Corrective_Action': ${JSON.stringify(prior_action || 'None')},
    'SpecificDescription_of_Issue': ${JSON.stringify(description || '')},
    'Expectation_for_Correction': ${JSON.stringify(expectation || '')},
    'TrainingAssigned_GoalsImprovement': ${JSON.stringify(training || '')},
    'TargetDate': ${JSON.stringify(target_date || '')},
}

for page in writer.pages:
    writer.update_page_form_field_values(page, fields)

# Handle checkboxes
btn_fields = {}

# Ongoing issue
ongoing_val = ${JSON.stringify(is_ongoing ? '/OngoingIssue_Yes' : '/OngoingIssue_No')}
btn_fields['Ongoing_Issue'] = ongoing_val

# Current action
btn_fields['CurrentAction_Counseling'] = ${JSON.stringify(action_counseling ? '/Yes' : '/Off')}
btn_fields['CurrentAction_VerbalWarning'] = ${JSON.stringify(action_verbal ? '/Yes' : '/Off')}
btn_fields['CurrentAction_WrittenWarning'] = ${JSON.stringify(action_written ? '/Yes' : '/Off')}
btn_fields['CurrentAction_FinalWarning'] = ${JSON.stringify(action_final ? '/Yes' : '/Off')}

# Issue categories
btn_fields['GeneralIssue_Absenteeism'] = ${JSON.stringify(issue_absenteeism ? '/Yes' : '/Off')}
btn_fields['GeneralIssue_Tardiness'] = ${JSON.stringify(issue_tardiness ? '/Yes' : '/Off')}
btn_fields['GeneralIssue_Conduct'] = ${JSON.stringify(issue_conduct ? '/Yes' : '/Off')}
btn_fields['GeneralIssue_SafetyViolation'] = ${JSON.stringify(issue_safety ? '/Yes' : '/Off')}
btn_fields['GeneralIssue_PolicyViolation'] = ${JSON.stringify(issue_policy ? '/Yes' : '/Off')}
btn_fields['GeneralIssue_WorkplacePerformance'] = ${JSON.stringify(issue_performance ? '/Yes' : '/Off')}

for page in writer.pages:
    writer.update_page_form_field_values(page, btn_fields)

with open(${JSON.stringify(tmpOut)}, 'wb') as f:
    writer.write(f)

print('ok')
`;

  try {
    const tmpScript = path.join(os.tmpdir(), `fill_${Date.now()}.py`);
    fs.writeFileSync(tmpScript, pythonScript);
    execSync(`python3 ${tmpScript}`, { timeout: 30000 });
    fs.unlinkSync(tmpScript);

    const pdfBuffer = fs.readFileSync(tmpOut);
    fs.unlinkSync(tmpOut);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="P3_Disciplinary_${(employee_name||'form').replace(/\s+/g,'_')}.pdf"`,
      'Content-Length': pdfBuffer.length
    });
    res.send(pdfBuffer);
  } catch(err) {
    console.error('PDF generation error:', err.message);
    res.status(500).json({ error: 'PDF generation failed: ' + err.message });
  }
});

app.get('/', (req, res) => {
  res.json({
    status: 'P3 Services API Proxy is running.',
    apiKeySet: !!API_KEY,
    formReady: fs.existsSync(BLANK_FORM_PATH)
  });
});

app.listen(PORT, () => {
  console.log('Proxy running on port ' + PORT);
  console.log('API Key set:', !!API_KEY);
  console.log('Blank form exists:', fs.existsSync(BLANK_FORM_PATH));
});
