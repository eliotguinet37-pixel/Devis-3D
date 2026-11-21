// À placer dans le dépôt à : functions/api/contact.js
// Cloudflare Pages Function : reçoit le formulaire (POST /api/contact)
// et envoie un e-mail via Resend, fichiers en pièces jointes.
//
// Variables d'environnement (à définir dans Cloudflare, jamais dans le code) :
//   RESEND_API_KEY  → clé API Resend (re_...)
//   TO_EMAIL        → ton adresse e-mail de réception
//   FROM_EMAIL      → (optionnel) expéditeur, par défaut "Impression 3D <onboarding@resend.dev>"

const MAX_FILES = 5;
const MAX_TOTAL = 15 * 1024 * 1024; // identique à la page
const ALLOWED = new Set([
  'stl', 'step', 'stp', 'obj', '3mf', 'iges', 'igs', 'dxf',
  'jpg', 'jpeg', 'png', 'webp', 'heic', 'pdf', 'zip',
]);
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clean(v, max) {
  return String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function oneLine(v, max) {
  return clean(v, max).replace(/[\r\n\t]+/g, ' ');
}

function fmtSize(n) {
  if (n < 1024) return n + ' o';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' Ko';
  return (n / 1024 / 1024).toFixed(1) + ' Mo';
}

function safeName(name) {
  const n = String(name || 'fichier')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .slice(-120);
  return n || 'fichier';
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

// ArrayBuffer -> base64 sans construire une énorme chaîne intermédiaire
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 3 * 8192; // multiple de 3 pour éviter le padding au milieu
  const parts = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))));
  }
  return parts.join('');
}

export async function onRequestPost({ request, env }) {
  if (!env.RESEND_API_KEY || !env.TO_EMAIL) {
    console.error('Variables RESEND_API_KEY / TO_EMAIL manquantes');
    return json({ ok: false, error: 'Service momentanément indisponible.' }, 500);
  }

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ ok: false, error: 'Requête invalide.' }, 400);
  }

  // Anti-spam : champ piège rempli, ou formulaire envoyé en moins de 2 secondes.
  // On répond "ok" pour ne rien révéler aux robots.
  const elapsed = Number(form.get('t'));
  if (clean(form.get('website'), 10) !== '' || !Number.isFinite(elapsed) || elapsed < 2000) {
    return json({ ok: true });
  }

  const name = oneLine(form.get('name'), 100);
  const email = oneLine(form.get('email'), 200);
  const material = oneLine(form.get('material'), 50);
  const quantity = oneLine(form.get('quantity'), 10);
  const deadline = oneLine(form.get('deadline'), 100);
  const description = clean(form.get('description'), 5000);

  if (!name) return json({ ok: false, error: 'Merci de renseigner votre nom.' }, 400);
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'Adresse e-mail invalide.' }, 400);
  if (description.length < 10) return json({ ok: false, error: 'Merci de décrire votre projet.' }, 400);

  // Fichiers
  const entries = form.getAll('files').filter((f) => f && typeof f === 'object' && 'arrayBuffer' in f && f.size > 0);
  if (entries.length > MAX_FILES) {
    return json({ ok: false, error: `Maximum ${MAX_FILES} fichiers.` }, 400);
  }
  let totalSize = 0;
  for (const f of entries) {
    totalSize += f.size;
    if (!ALLOWED.has(extOf(String(f.name || '')))) {
      return json({ ok: false, error: `Format non accepté : ${safeName(f.name)}` }, 400);
    }
  }
  if (totalSize > MAX_TOTAL) {
    return json({ ok: false, error: 'Fichiers trop volumineux (15 Mo maximum au total).' }, 413);
  }

  const attachments = [];
  const fileSummary = [];
  const used = new Set();
  for (const f of entries) {
    let fname = safeName(f.name);
    // évite deux pièces jointes avec le même nom
    if (used.has(fname)) fname = `${used.size + 1}_${fname}`;
    used.add(fname);
    attachments.push({ filename: fname, content: toBase64(await f.arrayBuffer()) });
    fileSummary.push(`${fname} (${fmtSize(f.size)})`);
  }

  const rows = [
    ['Nom', name],
    ['E-mail', email],
    ['Matière', material || '—'],
    ['Quantité', quantity || '—'],
    ['Délai', deadline || '—'],
  ];

  const text =
    `Nouvelle demande de devis impression 3D\n\n` +
    rows.map(([k, v]) => `${k} : ${v}`).join('\n') +
    `\n\nDescription :\n${description}\n\n` +
    `Fichiers joints : ${fileSummary.length ? fileSummary.join(', ') : 'aucun'}\n\n` +
    `Réponds simplement à cet e-mail pour écrire au client.`;

  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;color:#0f172a;max-width:600px">` +
    `<h2 style="margin:0 0 12px">Nouvelle demande de devis – impression 3D</h2>` +
    `<table style="border-collapse:collapse;width:100%">` +
    rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:6px 12px 6px 0;color:#5b6478;white-space:nowrap;vertical-align:top">${esc(k)}</td>` +
          `<td style="padding:6px 0"><strong>${
            k === 'E-mail' ? `<a href="mailto:${esc(v)}">${esc(v)}</a>` : esc(v)
          }</strong></td></tr>`
      )
      .join('') +
    `</table>` +
    `<h3 style="margin:18px 0 6px">Description</h3>` +
    `<div style="white-space:pre-wrap;background:#f4f6fb;border-radius:8px;padding:12px">${esc(description)}</div>` +
    `<h3 style="margin:18px 0 6px">Fichiers joints</h3>` +
    (fileSummary.length
      ? `<ul style="margin:0;padding-left:20px">${fileSummary.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`
      : `<p style="margin:0">Aucun fichier.</p>`) +
    `<p style="color:#5b6478;font-size:13px;margin-top:20px">Réponds simplement à cet e-mail pour écrire au client.</p>` +
    `</div>`;

  const payload = {
    from: env.FROM_EMAIL || 'Impression 3D <onboarding@resend.dev>',
    to: [env.TO_EMAIL],
    reply_to: email,
    subject: `[Devis 3D] ${name}${fileSummary.length ? ` – ${fileSummary.length} fichier(s)` : ''}`,
    text,
    html,
  };
  if (attachments.length) payload.attachments = attachments;

  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error('Resend injoignable', e);
    return json({ ok: false, error: "L'envoi a échoué. Merci de réessayer dans un instant." }, 502);
  }

  if (!res.ok) {
    console.error('Erreur Resend', res.status, await res.text());
    return json({ ok: false, error: "L'envoi a échoué. Merci de réessayer dans un instant." }, 502);
  }

  return json({ ok: true });
}
