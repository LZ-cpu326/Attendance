const $ = (id) => document.getElementById(id);
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WD = '日一二三四五六', pad = (n) => String(n).padStart(2, '0');
const fmt = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} (${WD[d.getDay()]})`; };
const tm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const ST = { present: ['出席', 'Present'], absent: ['缺席', 'Absent'], excused: ['請假', 'Excused'], pending: ['點名中', 'In progress'] };

function render(courses) {
  $('out').innerHTML = courses.map(({ course: c, student, sessions, attendance }) => {
    const map = new Map(attendance.map((a) => [a.session_id, a]));
    const rows = sessions.map((se) => { const a = map.get(se.id); return { se, a, st: a ? a.status : se.status === 'open' ? 'pending' : 'absent' }; });
    const abs = rows.filter((r) => r.st === 'absent').length;
    const total = c.planned_total > 0 ? c.planned_total : sessions.length;
    const zero = c.zero_at > 0 && abs >= c.zero_at;
    const per = c.deduct_per > 0 ? c.deduct_per : total ? c.max_score / total : 0;
    const score = zero ? 0 : Math.max(0, c.max_score - abs * per);
    return `<div class="card">
      <h2>${h(c.name)}</h2><div class="muted">${h(student.student_no)} ${h(student.name)}</div>
      <div class="sum">
        <div><b>${rows.filter((r) => r.st === 'present').length}</b><span>出席 Present</span></div>
        <div><b style="${abs ? 'color:var(--absent)' : ''}">${abs}</b><span>缺席 Absent</span></div>
        <div><b>${Math.round(score * 100) / 100}</b><span>出席分數 / ${c.max_score}</span></div>
      </div>
      ${zero ? `<div class="err" style="margin-bottom:.75rem">缺席已達 ${c.zero_at} 次，出席分數為 0。</div>` : abs && c.zero_at > 0 ? `<div class="muted" style="margin-bottom:.75rem">缺席達 ${c.zero_at} 次出席分數歸零，目前 ${abs} 次。</div>` : ''}
      <div class="list">${rows.slice().reverse().map(({ se, a, st }) => `
        <div class="item st-${st}">
          <div><div class="when">${fmt(se.opened_at)} ${h(se.label)}</div>
            <div class="sub">${a && a.source === 'qr' ? '簽到時間 ' + tm(a.checked_at) : a && a.source === 'manual' ? '助教登記' : ''}</div></div>
          <div class="st">${ST[st][0]} <span class="en" style="color:inherit">${ST[st][1]}</span></div>
        </div>`).join('') || '<div class="muted">尚無點名紀錄</div>'}</div>
    </div>`;
  }).join('');
}

$('f').onsubmit = async (e) => {
  e.preventDefault();
  const v = (n) => e.target.elements.namedItem(n).value;
  $('err').classList.add('hidden'); $('go').disabled = true;
  try {
    const r = await fetch('/api/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ student_no: v('student_no'), name: v('sname') }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || '連線錯誤');
    try { localStorage.setItem('me', JSON.stringify({ no: v('student_no'), name: v('sname') })); } catch {}
    render(d.courses);
    $('out').scrollIntoView({ behavior: 'smooth' });
  } catch (err) { $('err').textContent = err.message; $('err').classList.remove('hidden'); $('out').innerHTML = ''; }
  finally { $('go').disabled = false; }
};
try { const m = JSON.parse(localStorage.getItem('me') || 'null'); if (m) { $('f').elements.namedItem('student_no').value = m.no; $('f').elements.namedItem('sname').value = m.name; } } catch {}
