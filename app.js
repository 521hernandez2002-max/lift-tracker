// ---------------------------------------------------------------------------
// Lift Tracker — day-1 scope: log sets with separate L/R loads, bodyweight,
// "last time" lookup. Everything persists in IndexedDB via Dexie.
//
// Think of IndexedDB as a tiny database that lives in the browser. Dexie is a
// thin wrapper; `db.sets.add(obj)` is literally the API.
// ---------------------------------------------------------------------------

// --- 1. Schema -------------------------------------------------------------
const db = new Dexie('lifttracker');

// The strings below declare *indexes*. '++id' = auto-incrementing primary key.
// Anything else is an indexed field, which means we can query it fast
// (e.g. `db.sets.where('workout_id').equals(x)`). Unindexed fields are still
// stored on the object — they're just not searchable directly.
db.version(1).stores({
  exercises: '++id, name, side_mode',
  workouts:  '++id, date, day_label',
  sets:      '++id, workout_id, exercise_id, [workout_id+exercise_id]',
  bodyweight:'++id, date'
});

// --- 2. Seed exercises (runs once, only if table is empty) -----------------
const SEED_EXERCISES = [
  // Pull-focused
  { name: 'One-Arm Machine Row',      side_mode: 'unilateral', equipment: 'machine',   notes: '' },
  { name: 'One-Arm Lat Pulldown',     side_mode: 'unilateral', equipment: 'cable',     notes: '' },
  { name: 'Assisted Pull-Up',         side_mode: 'bilateral',  equipment: 'machine',   notes: 'wrist wrap L' },
  { name: 'Weighted Pull-Up',         side_mode: 'bilateral',  equipment: 'bodyweight',notes: 'wrist wrap L' },
  { name: 'Chest-Supported Row',      side_mode: 'bilateral',  equipment: 'machine',   notes: '' },
  { name: 'Seated Cable Row (Neutral)',side_mode:'bilateral',  equipment: 'cable',     notes: '' },
  { name: 'Straight-Arm Pulldown',    side_mode: 'bilateral',  equipment: 'cable',     notes: '' },
  { name: 'Hammer Curl (Seated)',     side_mode: 'unilateral', equipment: 'dumbbell',  notes: '' },
  { name: 'Rear Delt Cable Fly',      side_mode: 'unilateral', equipment: 'cable',     notes: '' },

  // Push-focused
  { name: 'Machine Chest Press',      side_mode: 'bilateral',  equipment: 'machine',   notes: '' },
  { name: 'Incline Press (Plate)',    side_mode: 'bilateral',  equipment: 'machine',   notes: '' },
  { name: 'Pec Fly',                  side_mode: 'bilateral',  equipment: 'machine',   notes: '' },
  { name: 'Machine Shoulder Press',   side_mode: 'bilateral',  equipment: 'machine',   notes: '' },
  { name: 'Cable Lateral Raise',      side_mode: 'unilateral', equipment: 'cable',     notes: '' },
  { name: 'Triceps Pushdown',         side_mode: 'bilateral',  equipment: 'cable',     notes: '' },
  { name: 'Landmine Press (One-Arm)', side_mode: 'unilateral', equipment: 'barbell',   notes: '' },

  // Lower + core
  { name: 'Hip Thrust',               side_mode: 'bilateral',  equipment: 'machine',   notes: '' },
  { name: 'Leg Press',                side_mode: 'bilateral',  equipment: 'machine',   notes: '' },
  { name: 'Hamstring Curl',           side_mode: 'bilateral',  equipment: 'machine',   notes: '' },
  { name: 'Leg Extension',            side_mode: 'bilateral',  equipment: 'machine',   notes: '' },
  { name: 'Single-Leg Calf Press',    side_mode: 'unilateral', equipment: 'machine',   notes: '' },
  { name: 'Cable Crunch',             side_mode: 'bilateral',  equipment: 'cable',     notes: '' },
];

async function seedIfEmpty() {
  const n = await db.exercises.count();
  if (n === 0) await db.exercises.bulkAdd(SEED_EXERCISES);
}

// --- 3. State + DOM helpers ------------------------------------------------
const state = {
  workout: null,        // active workout object, or null
  exercise: null,       // selected exercise while in screen-log
};

const $ = (id) => document.getElementById(id);
const today = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD

function show(screen) {
  // screen = 'home' | 'pick' | 'log'
  for (const s of ['home', 'pick', 'log']) {
    $('screen-' + s).hidden = (s !== screen);
  }
}

function setStatus(msg) {
  $('status').textContent = msg;
  if (msg) setTimeout(() => { if ($('status').textContent === msg) $('status').textContent = ''; }, 2000);
}

// --- 4. Render functions ---------------------------------------------------
async function renderHome() {
  const recent = await db.workouts.orderBy('date').reverse().limit(5).toArray();
  const ul = $('recent-list');
  ul.innerHTML = '';
  for (const w of recent) {
    const setCount = await db.sets.where('workout_id').equals(w.id).count();
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `<span>${w.date} — ${w.day_label}</span><span class="tag">${setCount} sets</span>`;
    li.onclick = () => resumeWorkout(w);
    ul.appendChild(li);
  }
}

async function renderExerciseList(filter = '') {
  const all = await db.exercises.orderBy('name').toArray();
  const q = filter.trim().toLowerCase();
  const list = q ? all.filter(e => e.name.toLowerCase().includes(q)) : all;
  const ul = $('exercise-list');
  ul.innerHTML = '';
  for (const ex of list) {
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `<span>${ex.name}</span><span class="tag">${ex.side_mode}</span>`;
    li.onclick = () => openExercise(ex);
    ul.appendChild(li);
  }
}

async function renderLastSession(exerciseId) {
  // Find the most recent *previous* workout that contained this exercise.
  const allSets = await db.sets
    .where('exercise_id').equals(exerciseId)
    .toArray();
  // Exclude the current workout's sets so "Last time" means actually last time.
  const prev = allSets.filter(s => s.workout_id !== state.workout.id);
  if (prev.length === 0) { $('last-session-body').textContent = 'No prior data.'; return; }

  // Group by workout_id and pick the most recent one.
  const byWorkout = {};
  for (const s of prev) (byWorkout[s.workout_id] ||= []).push(s);
  const workoutIds = Object.keys(byWorkout).map(Number);
  const workouts = await db.workouts.where('id').anyOf(workoutIds).toArray();
  workouts.sort((a, b) => b.date.localeCompare(a.date));
  const last = workouts[0];
  const sets = byWorkout[last.id].sort((a, b) => a.set_num - b.set_num);

  const lines = sets.map(s => {
    const right = (s.load_right != null)
      ? ` | R ${s.load_right}×${s.reps_right}`
      : '';
    return `#${s.set_num}: L ${s.load_left}×${s.reps_left}${right} @ RIR ${s.rir}${s.compensation ? ' ⚠' : ''}`;
  });
  $('last-session-body').innerHTML = `<div class="label">${last.date}</div>` + lines.map(l => `<div>${l}</div>`).join('');
}

async function renderThisSession() {
  if (!state.workout || !state.exercise) return;
  const sets = await db.sets
    .where('[workout_id+exercise_id]')
    .equals([state.workout.id, state.exercise.id])
    .sortBy('set_num');
  const ul = $('session-sets');
  ul.innerHTML = '';
  for (const s of sets) {
    const right = (s.load_right != null) ? ` | R ${s.load_right}×${s.reps_right}` : '';
    const li = document.createElement('li');
    li.className = 'set';
    li.textContent = `#${s.set_num}: L ${s.load_left}×${s.reps_left}${right} @ RIR ${s.rir}${s.compensation ? ' ⚠' : ''}${s.straps ? ' [straps]' : ''}`;
    ul.appendChild(li);
  }
}

// --- 5. Flow handlers ------------------------------------------------------
async function startWorkout() {
  const day_label = $('day-label').value;
  const bw = parseFloat($('bw-input').value);
  const id = await db.workouts.add({
    date: today(),
    day_label,
    bodyweight: Number.isFinite(bw) ? bw : null,
    notes: ''
  });
  if (Number.isFinite(bw)) await db.bodyweight.add({ date: today(), weight: bw, notes: '' });
  state.workout = await db.workouts.get(id);
  enterPickScreen();
}

async function resumeWorkout(w) {
  state.workout = w;
  enterPickScreen();
}

function enterPickScreen() {
  $('pick-title').textContent = state.workout.day_label;
  renderExerciseList($('search').value);
  show('pick');
}

async function openExercise(ex) {
  state.exercise = ex;
  $('log-title').textContent = ex.name;

  // Toggle right-side row based on side_mode. For bilateral we relabel and
  // hide the right column entirely so the form matches the movement.
  const isUni = (ex.side_mode === 'unilateral');
  $('row-right').hidden = !isUni;
  $('f-load-l-lbl').textContent = isUni ? 'Load L' : 'Load';
  $('f-reps-l-lbl').textContent = isUni ? 'Reps L' : 'Reps';
  $('f-load-r').required = isUni;
  $('f-reps-r').required = isUni;

  // Pre-fill set # with next number
  const nextSet = await db.sets
    .where('[workout_id+exercise_id]')
    .equals([state.workout.id, state.exercise.id])
    .count();
  $('f-set').value = nextSet + 1;

  // Clear inputs
  for (const id of ['f-load-l','f-reps-l','f-load-r','f-reps-r','f-rir','f-notes']) $(id).value = '';
  $('f-straps').checked = false;
  $('f-comp').checked = false;

  await renderLastSession(ex.id);
  await renderThisSession();
  show('log');
}

async function saveSet(e) {
  e.preventDefault();
  const isUni = (state.exercise.side_mode === 'unilateral');
  const load_l = parseFloat($('f-load-l').value);
  const reps_l = parseInt($('f-reps-l').value, 10);
  const load_r = isUni ? parseFloat($('f-load-r').value) : null;
  const reps_r = isUni ? parseInt($('f-reps-r').value, 10) : null;

  await db.sets.add({
    workout_id: state.workout.id,
    exercise_id: state.exercise.id,
    set_num: parseInt($('f-set').value, 10),
    load_left: load_l,
    load_right: load_r,
    reps_left: reps_l,
    reps_right: reps_r,
    rir: parseInt($('f-rir').value, 10),
    straps: $('f-straps').checked,
    compensation: $('f-comp').checked,
    notes: $('f-notes').value,
  });

  setStatus('Set saved');
  // Auto-advance set number; keep load/reps so the user tweaks them rather than retypes.
  $('f-set').value = parseInt($('f-set').value, 10) + 1;
  await renderThisSession();
}

// --- 6. Wire up events -----------------------------------------------------
function wire() {
  $('btn-start').onclick = startWorkout;
  $('btn-finish').onclick = () => { state.workout = null; state.exercise = null; show('home'); renderHome(); };
  $('btn-back').onclick = () => { state.exercise = null; enterPickScreen(); };
  $('search').oninput = (e) => renderExerciseList(e.target.value);
  $('set-form').onsubmit = saveSet;
  $('btn-bw-quick').onclick = async () => {
    const w = parseFloat($('bw-quick').value);
    if (!Number.isFinite(w)) return;
    await db.bodyweight.add({ date: today(), weight: w, notes: '' });
    $('bw-quick').value = '';
    setStatus('Bodyweight logged');
  };
}

// --- 7. Init ---------------------------------------------------------------
(async function init() {
  await seedIfEmpty();
  wire();
  await renderHome();
  show('home');
  if ('serviceWorker' in navigator) {
    // Register the service worker for offline support. Only works over HTTPS
    // or localhost, so it will silently fail if you open index.html as a
    // file:// URL — that's fine for local testing.
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
