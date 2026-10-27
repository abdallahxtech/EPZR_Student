# EPZR Student Connect — EasyPanel deployment

The landing page, application form and QR code generator for the Sorbonne University Abu Dhabi Volunteering Day (28 Oct 2026).

**What it does:**
- Shows the landing page: both contact paths (careers, plus education and research), the programmes, and the 14-slide portfolio with a PDF download.
- Has an **application form** that emails **career@emiratespark.ae** directly. The CV is attached, and the email subject reads
  `EPZR-SUAD-0001 | Internship | Sara Al Mansouri`
- Gives every application a serial number (`EPZR-SUAD-0001`, `0002`, …). The student sees it on screen and also gets a confirmation email that quotes it.
- Keeps a backup of every submission and CV in `/data`, even if the email fails.
- Generates the QR code for the domain the site is actually served on, so you can't print a wrong QR.

---

## 1. Deploy in EasyPanel (about 5 minutes)

1. Go to **Project → + Service → App**, name it `epzr-student-connect`.
2. **Source → Upload**: upload `EPZR_Student_Connect_App.zip`. The Dockerfile is at the root of the zip.
3. **Build → Dockerfile**: path `Dockerfile`.
4. **Environment**: paste the contents of `.env.example` and fill in the values (see section 2).
5. **Mounts → + Volume**: name `epzr-data`, mount path **`/data`**.
   ⚠️ Without this volume, serial numbers restart at 0001 and the saved submissions are lost every time you redeploy.
6. **Domains → + Domain**: your hostname (for example `students.emiratespark.ae`), **HTTPS on**, container port **80**.
   For a custom domain, add the DNS A or CNAME record first.
7. Click **Deploy**, then open the **Logs**. You should see:
   ```
   EPZR Student Connect on :80 | data /data | email via smtp.office365.com as career@emiratespark.ae -> career@emiratespark.ae
   SMTP login OK
   ```
   If you see `SMTP check FAILED`, go to section 2.

## 2. Email settings (Microsoft 365)

The app signs in to a mailbox to send the emails. Use the `career@emiratespark.ae` mailbox, or another licensed mailbox that has "Send As" rights on it.

| Variable | Value |
|---|---|
| `SMTP_HOST` | `smtp.office365.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `career@emiratespark.ae` |
| `SMTP_PASS` | that mailbox's password |
| `MAIL_FROM` | `career@emiratespark.ae` |
| `MAIL_TO` | `career@emiratespark.ae` |
| `MAIL_CC` | optional, e.g. `kukuh@emiratespark.ae` |
| `SERIAL_PREFIX` | `EPZR-SUAD` |
| `ADMIN_TOKEN` | a long random string |

**If the logs show `SMTP check FAILED` (error 535 or "SmtpClientAuthentication is disabled"):**
1. Go to **M365 admin center → Users → Active users →** the mailbox **→ Mail → Manage email apps** and tick **Authenticated SMTP**. Save.
2. Go to **Entra admin → Properties → Manage security defaults**. If security defaults are **on**, they block SMTP password sign-in. Either turn them off, or use a Conditional Access exclusion for this mailbox.
3. The mailbox cannot have MFA enforced for SMTP sign-in. Use a dedicated sending mailbox if needed.
4. Wait 10–15 minutes after changing these settings, then click **Restart** on the app.

Note: Microsoft plans to disable SMTP password sign-in by default for existing tenants at the end of December 2026, and admins can re-enable it. For long-term use, move to OAuth or Graph, or to a relay such as Brevo or SendGrid. Any SMTP relay works by changing `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` and `SMTP_PASS`.

**Safety net:** if email is not working, nothing is lost.
- Every application is saved in `/data/submissions.csv`, and CVs in `/data/cv/`.
- The student gets an **"Email my application"** button that opens their own email app with the same serial number and all their details filled in, addressed to career@emiratespark.ae.

## 3. QR code and print files (made automatically for your live domain)

Open these on the live site:

| URL | What it is |
|---|---|
| `https://YOUR-DOMAIN/print` | A5 table card. Press Ctrl+P → A5 → Margins: None → Background graphics on |
| `https://YOUR-DOMAIN/screen` | Full-screen slide for the event screen. Press F11 |
| `https://YOUR-DOMAIN/qr.svg` | QR code with the logo, as a vector for roll-ups and flyers |
| `https://YOUR-DOMAIN/qr-plain.png` | Plain QR code PNG, 1200 px |

To lock the QR to one address even when the site is opened from another, set `PUBLIC_URL=https://students.emiratespark.ae`.

⚠️ Throw away any QR printed before this deployment. The earlier one pointed to the temporary Claude page.

## 4. Check before the event

- [ ] `https://YOUR-DOMAIN/health` shows `ok`
- [ ] `https://YOUR-DOMAIN/api/status` shows `"email":"configured"`
- [ ] Submit one test application from a phone on **mobile data**. Check that career@ receives `EPZR-SUAD-0001 | …` with the CV attached, and that the test address gets the confirmation email.
- [ ] Scan the printed QR with 2 phones (iPhone camera and Android).
- [ ] The test application uses serial 0001. To start students at 0001, edit `/data/counter.json` to `{"last":0}` in the EasyPanel console, or just leave it.

## 5. Download all submissions

`https://YOUR-DOMAIN/admin/submissions.csv?token=YOUR_ADMIN_TOKEN` downloads a CSV of all applications, with serial, name, email, phone, interest and email status.
`https://YOUR-DOMAIN/admin/cv/EPZR-SUAD-0001_Sara-Al-Mansouri.pdf?token=YOUR_ADMIN_TOKEN` downloads one saved CV.

## Files
```
Dockerfile        node:22-alpine, runs server.js on port 80, data in /data
server.js         page + /api/apply (email) + QR/print routes + admin CSV
public/           index.html, images, slides, fonts, EPZR-Portfolio.pdf
templates/        print.html (A5 card), screen.html (event screen)
.env.example      all settings
```
Run locally: `npm ci && DATA_DIR=./data PORT=8080 node server.js`
