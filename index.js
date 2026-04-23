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

// PDF generation using pdf-lib with NeedAppearances flag
app.post('/api/generate-pdf', async (req, res) => {
  if (!fs.existsSync(BLANK_FORM_PATH)) return res.status(500).json({ error: 'Blank form not found on server.' });

  try {
    const { PDFDocument, PDFName, PDFString, PDFBool } = require('pdf-lib');

    const pdfBytes = fs.readFileSync(BLANK_FORM_PATH);
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

    // Set NeedAppearances = true so PDF viewer renders fields with our DA font
    try {
      const acroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'));
      if (acroForm && acroForm.set) {
        acroForm.set(PDFName.of('NeedAppearances'), PDFBool.True);
      }
    } catch(e) {
      console.log('NeedAppearances set skipped:', e.message);
    }

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
    const DA = `/Helv ${FONT_SIZE} Tf 0 g`;

    const textFields = {
      'Date_Form': date_form || '',
      'Employee_Name': employee_name || '',
      'Employee_Title': employee_title || '',
      'Employee_ID': employee_id || '',
      'Date_Hired': date_hired || '',
      'Employee_Department': department || '',
      'Manager_Name': manager_name || '',
      'Date_Occurrence': date_occurrence || '',
      'Location_Occurence': location || '',
      'Prior_Corrective_Action': prior_action || 'None',
      'TargetDate': target_date || '',
      'SpecificDescription_of_Issue': description || '',
      'Expectation_for_Correction': expectation || '',
      'TrainingAssigned_GoalsImprovement': training || '',
    };

    const checkboxFields = {
      'CurrentAction_Counseling': action_counseling,
      'CurrentAction_VerbalWarning': action_verbal,
      'CurrentAction_WrittenWarning': action_written,
      'CurrentAction_FinalWarning': action_final,
      'GeneralIssue_Absenteeism': issue_absenteeism,
      'GeneralIssue_Tardiness': issue_tardiness,
      'GeneralIssue_Conduct': issue_conduct,
      'GeneralIssue_SafetyViolation': issue_safety,
      'GeneralIssue_PolicyViolation': issue_policy,
      'GeneralIssue_WorkplacePerformance': issue_performance,
    };

    // Walk all widget annotations and set values + DA directly on the dict
    const pages = pdfDoc.getPages();
    for (const page of pages) {
      const annots = page.node.get(PDFName.of('Annots'));
      if (!annots) continue;

      for (let i = 0; i < annots.size(); i++) {
        const annotRef = annots.get(i);
        const annot = pdfDoc.context.lookup(annotRef);
        if (!annot) continue;

        const fieldName = annot.get(PDFName.of('T'));
        if (!fieldName) continue;
        const name = fieldName.decodeText ? fieldName.decodeText() : fieldName.value;

        const ft = annot.get(PDFName.of('FT'));

        if (ft && ft.encodedName === '/Tx' && textFields.hasOwnProperty(name)) {
          // Set value
          annot.set(PDFName.of('V'), PDFString.of(textFields[name]));
          // Set font size via DA
          annot.set(PDFName.of('DA'), PDFString.of(DA));
          // Clear AP so viewer regenerates appearance with our DA
          annot.delete(PDFName.of('AP'));
        }

        if (ft && ft.encodedName === '/Btn' && checkboxFields.hasOwnProperty(name)) {
          const checked = checkboxFields[name];
          annot.set(PDFName.of('V'), checked ? PDFName.of('Yes') : PDFName.of('Off'));
          annot.set(PDFName.of('AS'), checked ? PDFName.of('Yes') : PDFName.of('Off'));
        }
      }
    }

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
