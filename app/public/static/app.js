const form = document.getElementById('noteForm');
const input = document.getElementById('noteInput');
const list = document.getElementById('notes');
const message = document.getElementById('message');

async function loadNotes() {
  const res = await fetch('/api/notes');
  if (!res.ok) {
    message.textContent = 'Could not load notes';
    return;
  }
  const notes = await res.json();
  list.innerHTML = '';
  for (const note of notes) {
    const li = document.createElement('li');
    li.textContent = note.body; // textContent, not innerHTML, to avoid XSS
    list.appendChild(li);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  const res = await fetch('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: input.value }),
  });
  if (!res.ok) {
    const data = await res.json();
    message.textContent = data.error;
    return;
  }
  input.value = '';
  loadNotes();
});

loadNotes();
