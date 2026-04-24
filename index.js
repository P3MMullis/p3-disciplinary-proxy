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
app.use(express.static(__dirname));

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

app.post('/api/generate-pdf', async (req, res) => {
  if (!fs.existsSync(BLANK_FORM_PATH)) return res.status(500).json({ error: 'Blank form not found on server.' });

  try {
    const { PDFDocument, PDFName, PDFString, PDFBool } = require('pdf-lib');

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

    // Set NeedAppearances via the form's acroform dict
    try {
      const rawForm = form.acroForm;
      rawForm.set(PDFName.of('NeedAppearances'), PDFBool.True);
    } catch(e) { console.log('NeedAppearances skipped:', e.message); }

    const setText = (name, value) => {
      try {
        const field = form.getTextField(name);
        field.setText(value || '');
        field.setFontSize(FONT_SIZE);
        // Clear AP stream so viewer redraws with new font
        try {
          const fieldDict = field.acroField;
          fieldDict.delete(PDFName.of('AP'));
        } catch(e) {}
      } catch(e) { console.log('TextField not found:', name); }
    };

    const setCheck = (name, checked) => {
      try {
        const f = form.getCheckBox(name);
        checked ? f.check() : f.uncheck();
      } catch(e) { console.log('Checkbox not found:', name); }
    };

    setText('Date_Form', date_form);
    setText('Employee_Name', employee_name);
    setText('Employee_Title', employee_title);
    setText('Employee_ID', employee_id);
    setText('Date_Hired', date_hired);
    setText('Employee_Department', department);
    setText('Manager_Name', manager_name);
    setText('Date_Occurrence', date_occurrence);
    setText('Location_Occurence', location);
    setText('Prior_Corrective_Action', prior_action || 'None');
    setText('TargetDate', target_date);
    setText('SpecificDescription_of_Issue', description);
    setText('Expectation_for_Correction', expectation);
    setText('TrainingAssigned_GoalsImprovement', training);

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

    const filledPdf = await pdfDoc.save({ updateFieldAppearances: false });
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
// ── GENERATE DOCX ─────────────────────────────────────────────────────────────
app.post('/api/generate-docx', async (req, res) => {
  const { script } = req.body;
  if (!script) return res.status(400).json({ error: 'No script provided' });

  const tmpDir = '/tmp/docx_' + Date.now();
  const scriptPath = require('path').join(tmpDir, 'gen.js');
  const outPath = '/tmp/performance_review.docx';

  try {
    require('fs').mkdirSync(tmpDir, { recursive: true });
    const scriptWithPath = `process.chdir('${tmpDir}');\n${script}`;
    require('fs').writeFileSync(scriptPath, scriptWithPath);
    require('child_process').execSync('npm install docx --prefix ' + tmpDir, { timeout: 60000 });
    require('child_process').execSync(`node ${scriptPath}`, { timeout: 30000 });

    if (!require('fs').existsSync(outPath)) throw new Error('File not generated');

    const buf = require('fs').readFileSync(outPath);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="performance_review.docx"');
    res.send(buf);
  } catch (err) {
    console.error('DOCX error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { require('fs').rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    try { require('fs').unlinkSync(outPath); } catch {}
  }
});
app.listen(PORT, () => {
  console.log('Proxy running on port ' + PORT);
  console.log('API Key set:', !!API_KEY);
  console.log('Blank form exists:', fs.existsSync(BLANK_FORM_PATH));
});
