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
  const { empName, empTitle, supName, date, period, scores, narrative, goal1, goal2 } = req.body;
  if (!empName) return res.status(400).json({ error: 'No data provided' });

  try {
    const { Document, Packer, Paragraph, TextRun, TabStopType, TabStopPosition,
            AlignmentType } = require('docx');

    const RATING = ['','Poor','Fair','Satisfactory','Good','Excellent'];
    const CAT_KEYS = ['job_knowledge','work_quality','attendance','initiative','communication','dependability','responsibility','leadership'];
    const CAT_NAMES = ['Job Knowledge','Work Quality','Attendances/Punctuality','Initiative','Communication/Listening Skills','Dependability','Responsibility','Leadership'];

    const total = CAT_KEYS.reduce((s,k) => s + (parseInt(scores[k])||0), 0);
    const avg = (total / CAT_KEYS.length).toFixed(1);

    const catRow = (name, scoreKey) => {
      const s = parseInt(scores[scoreKey]) || 0;
      return new Paragraph({
        spacing: { before: 160, after: 40 },
        children: [
          new TextRun({ text: name + ':  ', bold: true, size: 22, font: 'Arial' }),
          new TextRun({ text: s ? `${s} - ${RATING[s]}` : '', size: 22, font: 'Arial' })
        ]
      });
    };

    const narrativeLines = (narrative || '').split('\n').filter(l => l.trim());

    const doc = new Document({
      sections: [{
        properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER, spacing: { after: 240 },
            children: [new TextRun({ text: 'EMPLOYEE PERFORMANCE REVIEW', bold: true, size: 28, font: 'Arial' })]
          }),
          new Paragraph({
            spacing: { after: 100 },
            tabStops: [{ type: TabStopType.LEFT, position: 5400 }],
            children: [
              new TextRun({ text: 'Name:  ', bold: true, size: 22, font: 'Arial' }),
              new TextRun({ text: empName || '', size: 22, font: 'Arial' }),
              new TextRun({ text: '\t' }),
              new TextRun({ text: 'Date:  ', bold: true, size: 22, font: 'Arial' }),
              new TextRun({ text: date || '', size: 22, font: 'Arial' })
            ]
          }),
          new Paragraph({
            spacing: { after: 100 },
            tabStops: [{ type: TabStopType.LEFT, position: 5400 }],
            children: [
              new TextRun({ text: 'Job Title:  ', bold: true, size: 22, font: 'Arial' }),
              new TextRun({ text: empTitle || '', size: 22, font: 'Arial' }),
              new TextRun({ text: '\t' }),
              new TextRun({ text: 'Supervisor:  ', bold: true, size: 22, font: 'Arial' }),
              new TextRun({ text: supName || '', size: 22, font: 'Arial' })
            ]
          }),
          new Paragraph({
            spacing: { after: 200 },
            children: [
              new TextRun({ text: 'Review Period:  ', bold: true, size: 22, font: 'Arial' }),
              new TextRun({ text: period || '', size: 22, font: 'Arial' })
            ]
          }),
          new Paragraph({
            spacing: { after: 240 },
            children: [new TextRun({ text: 'RATINGS:     1-Poor     2-Fair     3-Satisfactory     4-Good     5-Excellent', bold: true, size: 22, font: 'Arial' })]
          }),
          ...CAT_KEYS.flatMap((key, i) => [
            catRow(CAT_NAMES[i], key),
            new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: 'Comments:  ', bold: true, size: 22, font: 'Arial' })] })
          ]),
          new Paragraph({
            spacing: { before: 200, after: 100 },
            children: [new TextRun({ text: `Overall Rating (average the rating numbers above)   ${avg}`, bold: true, size: 22, font: 'Arial' })]
          }),
          new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: 'Evaluation:', bold: true, size: 22, font: 'Arial' })] }),
          ...narrativeLines.map(line => new Paragraph({
            spacing: { after: 120 },
            children: [new TextRun({ text: line, size: 22, font: 'Arial' })]
          })),
          new Paragraph({
            spacing: { before: 240, after: 120 },
            children: [new TextRun({ text: 'GOALS: (as agreed upon by employee and supervisor)', bold: true, size: 22, font: 'Arial' })]
          }),
          new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: 'Goal #1:  ', bold: true, size: 22, font: 'Arial' }), new TextRun({ text: goal1 || '', size: 22, font: 'Arial' })] }),
          new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: 'Goal #2:  ', bold: true, size: 22, font: 'Arial' }), new TextRun({ text: goal2 || '', size: 22, font: 'Arial' })] }),
          new Paragraph({ spacing: { before: 200, after: 160 }, children: [new TextRun({ text: 'VERIFICATION OF REVIEW:', bold: true, size: 22, font: 'Arial' })] }),
          new Paragraph({ spacing: { after: 320 }, children: [new TextRun({ text: 'By signing this form, you confirm that you have discussed this review in detail with your supervisor.  Signing the form does not necessarily indicate that you agree with the evaluation.', size: 20, font: 'Arial' })] }),
          new Paragraph({
            spacing: { after: 120 },
            tabStops: [{ type: TabStopType.LEFT, position: 5400 }],
            children: [new TextRun({ text: '__________________________', size: 22, font: 'Arial' }), new TextRun({ text: '\t' }), new TextRun({ text: 'Date: __________________', size: 22, font: 'Arial' })]
          }),
          new Paragraph({ spacing: { after: 280 }, children: [new TextRun({ text: 'Employee Signature', bold: true, size: 20, font: 'Arial' })] }),
          new Paragraph({
            spacing: { after: 120 },
            tabStops: [{ type: TabStopType.LEFT, position: 5400 }],
            children: [new TextRun({ text: '__________________________', size: 22, font: 'Arial' }), new TextRun({ text: '\t' }), new TextRun({ text: 'Date: ___________________', size: 22, font: 'Arial' })]
          }),
          new Paragraph({ children: [new TextRun({ text: 'Supervisor Signature', bold: true, size: 20, font: 'Arial' })] })
        ]
      }]
    });

    const buf = await Packer.toBuffer(doc);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="Performance_Review_${(empName||'').replace(/\s+/g,'_')}.docx"`);
    res.send(buf);

  } catch (err) {
    console.error('DOCX error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.listen(PORT, () => {
  console.log('Proxy running on port ' + PORT);
  console.log('API Key set:', !!API_KEY);
  console.log('Blank form exists:', fs.existsSync(BLANK_FORM_PATH));
});
