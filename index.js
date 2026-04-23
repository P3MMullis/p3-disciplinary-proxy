const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const BLANK_FORM_PATH = path.join(__dirname, 'blank_form.pdf');

app.use(cors());
app.use(express.json({ limit: '10mb' }));

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

// PDF form filling
app.post('/api/generate-pdf', async (req, res) => {
  if (!fs.existsSync(BLANK_FORM_PATH)) return res.status(500).json({ error: 'Blank form not found on server.' });

  try {
    const { PDFDocument } = require('pdf-lib');
    const { degrees } = require('pdf-lib');

    const pdfBytes = fs.readFileSync(BLANK_FORM_PATH);
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const form = pdfDoc.getForm();

    const {
      date_form, employee_name, employee_title, employee_id,
      date_hired, department, manager_name, date_occurrence,
      location, prior_action,
      action_counseling, action_verbal, action_written, action_final,
      issue_absenteeism, issue_tardiness, issue_conduct,
      issue_safety, issue_policy, issue_performance,
      description, expectation, training, target_date
    } = req.body;

    const FONT_SIZE = 11;

    const setText = (name, value, fontSize) => {
      try {
        const field = form.getTextField(name);
        field.setText(value || '');
        field.setFontSize(fontSize || FONT_SIZE);
      } catch(e) { console.log('Field not found:', name); }
    };

    const setCheck = (name, checked) => {
      try { const f = form.getCheckBox(name); checked ? f.check() : f.uncheck(); }
      catch(e) { console.log('Checkbox not found:', name); }
    };

    // All fields at consistent font size
    setText('Date_Form', date_form || '', FONT_SIZE);
    setText('Employee_Name', employee_name || '', FONT_SIZE);
    setText('Employee_Title', employee_title || '', FONT_SIZE);
    setText('Employee_ID', employee_id || '', FONT_SIZE);
    setText('Date_Hired', date_hired || '', FONT_SIZE);
    setText('Employee_Department', department || '', FONT_SIZE);
    setText('Manager_Name', manager_name || '', FONT_SIZE);
    setText('Date_Occurrence', date_occurrence || '', FONT_SIZE);
    setText('Location_Occurence', location || '', FONT_SIZE);
    setText('Prior_Corrective_Action', prior_action || 'None', FONT_SIZE);
    setText('TargetDate', target_date || '', FONT_SIZE);
    setText('SpecificDescription_of_Issue', description || '', FONT_SIZE);
    setText('Expectation_for_Correction', expectation || '', FONT_SIZE);
    setText('TrainingAssigned_GoalsImprovement', training || '', FONT_SIZE);

    // Checkboxes
    setCheck('CurrentAction_Counseling', action_counseling);
    setCheck('CurrentAction_VerbalWarning', action_verbal);
    setCheck('CurrentAction_WrittenWarning', action_written);
    setCheck('CurrentAction_FinalWarning', action_final);
    setCheck('GeneralIssue_Absenteeism', issue_absenteeism);
    setCheck('GeneralIssue_Tardiness', issue_tardiness);
    setCheck('GeneralIssue_Conduct', issue_conduct);
    setCheck('GeneralIssue_SafetyViolation', issue_safety);
    setCheck('GeneralIssue_PolicyViolation', issue_policy);
    setCheck('GeneralIssue_WorkplacePerformance', issue_performance);

    form.flatten();
    const filledPdf = await pdfDoc.save();

    const safeName = (employee_name || 'form').replace(/\s+/g, '_');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="P3_Disciplinary_${safeName}.pdf"`,
      'Content-Length': filledPdf.length
    });
    res.send(Buffer.from(filledPdf));

  } catch(err) {
    console.error('PDF error:', err.message);
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
