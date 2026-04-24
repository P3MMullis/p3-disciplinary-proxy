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
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
            AlignmentType, BorderStyle, WidthType, ShadingType, HeadingLevel } = require('docx');

    const RATING = ['','Poor','Fair','Satisfactory','Good','Excellent'];
    const border = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
    const borders = { top: border, bottom: border, left: border, right: border };
    const cell = (text, bold, shade) => new TableCell({
      borders,
      width: { size: 4680, type: WidthType.DXA },
      shading: shade ? { fill: '1A2340', type: ShadingType.CLEAR } : undefined,
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({ children: [new TextRun({ text: text || '', bold: !!bold, color: shade ? 'FFFFFF' : '000000', size: 20 })] })]
    });

    const CATS = ['job_knowledge','work_quality','attendance','initiative','communication','dependability','responsibility','leadership'];
    const CAT_NAMES = ['Job Knowledge','Work Quality','Attendance / Punctuality','Initiative','Communication / Listening','Dependability','Responsibility','Leadership'];

    const total = CATS.reduce((s,k) => s + (parseInt(scores[k])||0), 0);
    const avg = (total / CATS.length).toFixed(1);

    const doc = new Document({
      sections: [{
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
          }
        },
        children: [
          // Title
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 300 },
            children: [new TextRun({ text: 'EMPLOYEE PERFORMANCE REVIEW', bold: true, size: 32, font: 'Arial' })]
          }),

          // Info table
          new Table({
            width: { size: 9360, type: WidthType.DXA },
            columnWidths: [2340, 2340, 2340, 2340],
            rows: [
              new TableRow({ children: [
                cell('Employee Name', true, true), cell(empName, false, false),
                cell('Date', true, true), cell(date, false, false)
              ]}),
              new TableRow({ children: [
                cell('Job Title', true, true), cell(empTitle, false, false),
                cell('Supervisor', true, true), cell(supName, false, false)
              ]}),
              new TableRow({ children: [
                cell('Review Period', true, true),
                new TableCell({
                  borders, columnSpan: 3,
                  width: { size: 7020, type: WidthType.DXA },
                  margins: { top: 80, bottom: 80, left: 120, right: 120 },
                  children: [new Paragraph({ children: [new TextRun({ text: period || '', size: 20 })] })]
                })
              ]})
            ]
          }),

          new Paragraph({ spacing: { before: 240, after: 120 }, children: [new TextRun({ text: 'RATINGS:  1 - Poor     2 - Fair     3 - Satisfactory     4 - Good     5 - Excellent', bold: true, size: 20, font: 'Arial' })] }),

          // Scores table
          new Table({
            width: { size: 9360, type: WidthType.DXA },
            columnWidths: [6240, 1560, 1560],
            rows: [
              new TableRow({ children: [
                cell('Category', true, true),
                cell('Score', true, true),
                cell('Rating', true, true)
              ]}),
              ...CATS.map((k, i) => new TableRow({ children: [
                new TableCell({ borders, width: { size: 6240, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: CAT_NAMES[i], size: 20 })] })] }),
                new TableCell({ borders, width: { size: 1560, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(scores[k]||0), bold: true, size: 20 })] })] }),
                new TableCell({ borders, width: { size: 1560, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: RATING[scores[k]||0]||'', size: 20 })] })] })
              ]})),
              new TableRow({ children: [
                new TableCell({ borders, shading: { fill: 'F4F6FA', type: ShadingType.CLEAR }, width: { size: 6240, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: 'Overall Average', bold: true, size: 20 })] })] }),
                new TableCell({ borders, shading: { fill: 'F4F6FA', type: ShadingType.CLEAR }, width: { size: 1560, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: avg, bold: true, size: 20 })] })] }),
                new TableCell({ borders, shading: { fill: 'F4F6FA', type: ShadingType.CLEAR }, width: { size: 1560, type: WidthType.DXA }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: RATING[Math.round(avg)]||'', bold: true, size: 20 })] })] })
              ]})
            ]
          }),

          // Comments / Narrative
          new Paragraph({ spacing: { before: 300, after: 120 }, children: [new TextRun({ text: 'Comments:', bold: true, size: 22, font: 'Arial' })] }),
          ...(narrative || '').split('\n').filter(l => l.trim()).map(line =>
            new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: line, size: 20, font: 'Arial' })] })
          ),

          // Overall rating
          new Paragraph({ spacing: { before: 200, after: 120 }, children: [new TextRun({ text: 'Overall Rating (average): ' + avg + ' — ' + (RATING[Math.round(avg)]||''), bold: true, size: 20, font: 'Arial' })] }),

          // Goals
          new Paragraph({ spacing: { before: 240, after: 120 }, children: [new TextRun({ text: 'GOALS: (as agreed upon by employee and supervisor)', bold: true, size: 22, font: 'Arial' })] }),
          new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: 'Goal #1:  ' + (goal1 || ''), size: 20, font: 'Arial' })] }),
          new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: 'Goal #2:  ' + (goal2 || ''), size: 20, font: 'Arial' })] }),

          // Verification
          new Paragraph({ spacing: { before: 200, after: 200 }, children: [new TextRun({ text: 'VERIFICATION OF REVIEW:', bold: true, size: 20, font: 'Arial' })] }),
          new Paragraph({ spacing: { after: 300 }, children: [new TextRun({ text: 'By signing this form, you confirm that you have discussed this review in detail with your supervisor. Signing the form does not necessarily indicate that you agree with the evaluation.', size: 18, font: 'Arial' })] }),

          // Signature lines
          new Paragraph({ spacing: { after: 400 }, children: [
            new TextRun({ text: 'Employee Signature: ________________________________     Date: _______________', size: 20, font: 'Arial' })
          ]}),
          new Paragraph({ children: [
            new TextRun({ text: 'Supervisor Signature: ________________________________     Date: _______________', size: 20, font: 'Arial' })
          ]})
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
