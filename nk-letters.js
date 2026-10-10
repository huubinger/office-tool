// ================= NECKARSULMER KONZERTE: SPONSOREN-BRIEFE (PDF) =================
// Rechnung (Sponsoring), Zuwendungsbestaetigung (Geldzuwendung nach amtlichem Muster) und Dankesbrief.
// Absenderdaten kommen aus den Vereinsdaten (Reiter Sponsoren › Vereinsdaten).

const { newDoc, euro } = require('./nk-report');

const fmtDate = (iso) => (iso ? new Date(iso + 'T12:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
const longDate = (d = new Date()) => d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });

// Betrag in Worten ("eintausendzweihundert Euro und fünfzig Cent")
const ONES = ['', 'ein', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn'];
const TENS = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];
function below1000(n) {
  let out = '';
  if (n >= 100) { out += ONES[Math.floor(n / 100)] + 'hundert'; n %= 100; }
  if (n >= 20) out += (n % 10 ? ONES[n % 10] + 'und' : '') + TENS[Math.floor(n / 10)];
  else if (n > 0) out += ONES[n];
  return out;
}
function inWords(n) {
  if (n === 0) return 'null';
  let out = '';
  const millions = Math.floor(n / 1e6), thousands = Math.floor((n % 1e6) / 1000), rest = n % 1000;
  if (millions) out += (millions === 1 ? 'eine Million ' : below1000(millions) + ' Millionen ');
  if (thousands) out += below1000(thousands) + 'tausend';
  if (rest) out += below1000(rest);
  out = out.trim();
  return out.endsWith('ein') ? out + 's' : out;
}
function amountInWords(amount) {
  const euros = Math.floor(amount), cents = Math.round((amount - euros) * 100);
  const w = (n) => (n === 1 ? 'ein' : inWords(n));
  return `${w(euros)} Euro${cents ? ` und ${w(cents)} Cent` : ''}`;
}

function letterhead(doc, org) {
  const left = doc.page.margins.left;
  doc.font('bold').fontSize(13).fillColor('#2a2620').text(org.name || 'Verein (bitte unter Vereinsdaten eintragen)', left, 50);
  doc.font('regular').fontSize(8.5).fillColor('#777')
    .text([String(org.address || '').replace(/\n/g, ' · '), org.phone, org.email, org.website].filter(Boolean).join(' · '));
  doc.moveTo(left, doc.y + 6).lineTo(doc.page.width - doc.page.margins.right, doc.y + 6).strokeColor('#d9d2c5').lineWidth(0.7).stroke();
  // Anschriftfeld (DIN 5008, Fenster links)
  doc.fillColor('#999').fontSize(7).text([org.name, String(org.address || '').replace(/\n/g, ', ')].filter(Boolean).join(' · '), left, 130, { width: 240 });
  doc.fillColor('#000');
}
function recipient(doc, sponsor) {
  const left = doc.page.margins.left;
  doc.font('regular').fontSize(10.5).text([sponsor.name, sponsor.contact_person, sponsor.address].filter(Boolean).join('\n'), left, 145, { width: 250 });
}
function footer(doc, org) {
  const lines = [
    [org.bank, org.iban && `IBAN ${org.iban}`, org.bic && `BIC ${org.bic}`].filter(Boolean).join(' · '),
    [org.tax_number && `Steuernummer ${org.tax_number}`, org.tax_office && `Finanzamt ${org.tax_office}`, org.vat_id && `USt-IdNr. ${org.vat_id}`].filter(Boolean).join(' · '),
  ].filter(Boolean);
  if (!lines.length) return;
  const y = doc.page.height - 70;
  doc.font('regular').fontSize(7.5).fillColor('#888').text(lines.join('\n'), doc.page.margins.left, y, { width: doc.page.width - 100, align: 'center' });
  doc.fillColor('#000');
}
const occasion = (sh) => (sh.concert_title ? `„${sh.concert_title}“${sh.concert_date ? ` am ${fmtDate(sh.concert_date)}` : ''}` : (sh.year ? `die Konzertsaison ${sh.year}` : 'unsere Konzerte'));

function rechnung(doc, { sponsor, sh, org }) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  letterhead(doc, org);
  recipient(doc, sponsor);
  doc.fontSize(10).text(`${org.city ? org.city + ', ' : ''}${fmtDate(sh.invoice_date)}`, left, 250, { width: right - left, align: 'right' });
  doc.font('bold').fontSize(15).text(`Rechnung ${sh.invoice_number}`, left, 290);
  doc.font('regular').fontSize(10.5).moveDown(0.8)
    .text(sponsor.contact_person ? `Guten Tag ${sponsor.contact_person},` : 'Sehr geehrte Damen und Herren,')
    .moveDown(0.6)
    .text(`vielen Dank für Ihre Unterstützung als Sponsor. Für die vereinbarten Werbeleistungen im Rahmen von ${occasion(sh)} stellen wir Ihnen in Rechnung:`);
  doc.moveDown(1);
  const rate = Number(org.vat_rate) || 0;
  const gross = sh.amount;
  const net = rate ? Math.round(gross / (1 + rate / 100) * 100) / 100 : gross;
  const vat = Math.round((gross - net) * 100) / 100;
  const row = (label, value, bold) => {
    const y = doc.y;
    doc.font(bold ? 'bold' : 'regular');
    const h = doc.heightOfString(label, { width: 330 });
    doc.text(label, left, y, { width: 330 });
    doc.text(value, right - 130, y, { width: 130, align: 'right' });
    doc.x = left;
    doc.y = y + h + 6;
  };
  const benefits = sh.benefits.length ? sh.benefits.map(b => b.text).join(', ') : (sponsor.consideration || 'Werbeleistungen laut Vereinbarung');
  row(`Sponsoring ${occasion(sh)}\nLeistungen: ${benefits}`, euro(net));
  if (rate) row(`zzgl. ${String(rate).replace('.', ',')} % Umsatzsteuer`, euro(vat));
  doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor('#bbb').stroke();
  doc.y += 6;
  row('Gesamtbetrag', euro(gross), true);
  doc.font('regular').moveDown(0.6);
  if (!rate) doc.fontSize(9.5).text(org.vat_note || 'Hinweis zur Umsatzsteuer bitte unter Vereinsdaten eintragen (z. B. Steuerbefreiung oder Kleinunternehmerregelung).', left).moveDown(0.6);
  doc.fontSize(10.5).text(`Leistungszeitraum: ${sh.concert_date ? fmtDate(sh.concert_date) : (sh.year || '')}`, left).moveDown(0.6);
  doc.text(`Bitte überweisen Sie den Betrag innerhalb von 14 Tagen${org.iban ? ` auf das Konto IBAN ${org.iban}${org.bank ? ` (${org.bank})` : ''}` : ''} unter Angabe der Rechnungsnummer ${sh.invoice_number}.`, left)
    .moveDown(1.2).text('Mit freundlichen Grüßen').moveDown(2).text(org.signer || org.name || '');
  footer(doc, org);
}

function spende(doc, { sponsor, sh, org }) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  doc.font('regular').fontSize(9).text(`Aussteller (Bezeichnung und Anschrift der steuerbegünstigten Einrichtung):\n${[org.name, org.address].filter(Boolean).join('\n')}`, left, 50, { width });
  doc.moveDown(1).font('bold').fontSize(12.5)
    .text('Bestätigung über Geldzuwendungen', { width })
    .font('regular').fontSize(9)
    .text('im Sinne des § 10b des Einkommensteuergesetzes an eine der in § 5 Abs. 1 Nr. 9 des Körperschaftsteuergesetzes bezeichneten Körperschaften, Personenvereinigungen oder Vermögensmassen', { width });
  doc.moveDown(1);
  const box = (label, value) => {
    doc.font('regular').fontSize(8).fillColor('#666').text(label, { width }).fillColor('#000').font('bold').fontSize(10.5).text(value || ' ', { width }).moveDown(0.6);
  };
  box('Name und Anschrift des Zuwendenden', [sponsor.name, sponsor.contact_person, String(sponsor.address || '').replace(/\n/g, ', ')].filter(Boolean).join(', '));
  box('Betrag der Zuwendung – in Ziffern –', euro(sh.amount));
  box('– in Buchstaben –', amountInWords(sh.amount));
  box('Tag der Zuwendung', sh.concert_date ? fmtDate(sh.concert_date) : (sh.year ? String(sh.year) : ''));
  doc.font('regular').fontSize(9.5)
    .text('Es handelt sich um den Verzicht auf Erstattung von Aufwendungen: Nein', { width }).moveDown(0.8)
    .text(`Wir sind wegen ${org.purpose || 'Förderung von Kunst und Kultur'} nach dem Freistellungsbescheid bzw. nach der Anlage zum Körperschaftsteuerbescheid des Finanzamtes ${org.tax_office || '______'}, StNr. ${org.tax_number || '______'}, vom ${org.exemption_date || '______'} für den letzten Veranlagungszeitraum ${org.exemption_year || '______'} nach § 5 Abs. 1 Nr. 9 des Körperschaftsteuergesetzes von der Körperschaftsteuer und nach § 3 Nr. 6 des Gewerbesteuergesetzes von der Gewerbesteuer befreit.`, { width })
    .moveDown(0.8)
    .text(`Es wird bestätigt, dass die Zuwendung nur zur ${org.purpose || 'Förderung von Kunst und Kultur'} verwendet wird.`, { width })
    .moveDown(2)
    .text(`${org.city || '______'}, ${longDate()}`, { width }).moveDown(2.2)
    .text('______________________________', { width }).fontSize(8.5).text(`(Unterschrift des Zuwendungsempfängers)${org.signer ? ' ' + org.signer : ''}`, { width });
  doc.moveDown(1.6).font('bold').fontSize(8).text('Hinweis:', { width }).font('regular').fontSize(7.5)
    .text('Wer vorsätzlich oder grob fahrlässig eine unrichtige Zuwendungsbestätigung erstellt oder veranlasst, dass Zuwendungen nicht zu den in der Zuwendungsbestätigung angegebenen steuerbegünstigten Zwecken verwendet werden, haftet für die entgangene Steuer (§ 10b Abs. 4 EStG, § 9 Abs. 3 KStG, § 9 Nr. 5 GewStG). Diese Bestätigung wird nicht als Nachweis für die steuerliche Berücksichtigung der Zuwendung anerkannt, wenn das Datum des Freistellungsbescheides länger als 5 Jahre bzw. das Datum der Feststellung der Einhaltung der satzungsmäßigen Voraussetzungen nach § 60a Abs. 1 AO länger als 3 Jahre seit Ausstellung der Bestätigung zurückliegt (§ 63 Abs. 5 AO).', { width });
}

function dank(doc, { sponsor, sh, org }) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  letterhead(doc, org);
  recipient(doc, sponsor);
  doc.fontSize(10).text(`${org.city ? org.city + ', ' : ''}${longDate()}`, left, 250, { width: right - left, align: 'right' });
  doc.font('bold').fontSize(14).text('Herzlichen Dank für Ihre Unterstützung!', left, 290);
  doc.font('regular').fontSize(10.5).moveDown(0.9)
    .text(sponsor.contact_person ? `Guten Tag ${sponsor.contact_person},` : 'Sehr geehrte Damen und Herren,')
    .moveDown(0.6)
    .text(`im Namen des gesamten Teams möchten wir uns ganz herzlich für Ihre Unterstützung${sh.amount ? ` in Höhe von ${euro(sh.amount)}` : ''} für ${occasion(sh)} bedanken.`, { width: right - left })
    .moveDown(0.6)
    .text('Ohne Partner wie Sie wären Konzerte in dieser Form in Neckarsulm nicht möglich. Sie tragen dazu bei, dass Kultur vor Ort lebendig bleibt und viele Menschen besondere Abende erleben können.', { width: right - left })
    .moveDown(0.6)
    .text('Wir würden uns sehr freuen, Sie auch bei unseren nächsten Veranstaltungen wieder an unserer Seite zu wissen.', { width: right - left })
    .moveDown(1.4).text('Mit herzlichen Grüßen').moveDown(2).text(org.signer || org.name || '');
  footer(doc, org);
}

function render(type, data, res) {
  const doc = newDoc({ margins: { top: 50, bottom: 50, left: 62, right: 55 } });
  doc.pipe(res);
  ({ rechnung, spende, dank }[type])(doc, data);
  doc.end();
}

module.exports = { render, amountInWords };
