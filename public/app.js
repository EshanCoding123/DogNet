let map;
let markers = [];
const petListContainerId = 'petListContainer';

//session flag: set to true when the current user's device is detected to be at their home
window.userIsAtHome = false;

//distance calculation (meters)
function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = v => v * Math.PI / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

//check whether the current user is physically at their home location.
//sets window.userIsAtHome =true if within thresholdMeters.
async function checkIfAtHome(thresholdMeters = 50) {
  try {
    if (!window.currentUserId || !navigator.geolocation) { window.userIsAtHome = false; return; }
    //fetch home location
    const uRes = await fetch(`/user/${window.currentUserId}`);
    const uj = await uRes.json();
    if (!uj || !uj.success || !uj.user || !uj.user.homeLocation) { window.userIsAtHome = false; return; }
    const home = uj.user.homeLocation;
    //get current device position (best-effort,may prompt the user once)
    navigator.geolocation.getCurrentPosition((pos) => {
      try {
        const lat = Number(pos.coords.latitude);
        const lon = Number(pos.coords.longitude);
        const dist = haversineMeters(lat, lon, Number(home.lat), Number(home.lon));
        window.userIsAtHome = (dist <= thresholdMeters);
        console.debug('checkIfAtHome:', { lat, lon, home, dist, userIsAtHome: window.userIsAtHome });
      } catch (err) { console.warn('checkIfAtHome compute failed', err); window.userIsAtHome = false; }
    }, (err) => {
      //cannot get position ->default to not at home
      console.warn('checkIfAtHome geolocation failed', err);
      window.userIsAtHome = false;
    }, { maximumAge: 30 * 1000, timeout: 5000 });
  } catch (err) {
    console.warn('checkIfAtHome error', err);
    window.userIsAtHome = false;
  }
}

async function loadDogs() {
  try {
  const res = await fetch("/locations", { headers: { ...(window.authToken ? { 'Authorization': 'Bearer ' + window.authToken } : {}) } });
    const dogs = await res.json();

  markers.forEach((m) => m.setMap(null));
  markers = [];

  //debug output: show payload and map state
  console.debug('app.js: fetched /locations ->', dogs);
  if (!map) console.warn('app.js: map is undefined when loadDogs ran');

  //render pet list for the current user (or show all if not logged in)
  try { renderPetList(dogs); } catch (e) { console.warn('renderPetList failed', e); }

  //for each location,  we have lat/lon and dogId
  for (const dog of dogs) {
    const lat = dog.lat === undefined || dog.lat === null ? null : Number(dog.lat);
    const lon = dog.lon === undefined || dog.lon === null ? null : Number(dog.lon);
    if (lat === null || lon === null) continue;

        //if profile is missing or incomplete, fetch by dogId
        let profile = dog.profile;
        if ((!profile || !profile.name) && dog.dogId) {
          try {
            const pRes = await fetch(`/dog/${dog.dogId}`);
            const pJson = await pRes.json();
            if (pJson.success && pJson.profile) profile = pJson.profile;
          } catch (err) {
            console.error('failed to fetch dog profile for', dog.dogId, err);
          }
        }

        if (!map) {
          console.warn('app.js: map not ready; skipping marker for', dog);
          continue;
        }

        //if this dog belongs to the current user and the user is at home,
        //hide the marker for privacy (do not show latest device position on the map).
        const isOwnerDog = window.currentUserId && dog.profile && String(dog.profile.ownerId) === String(window.currentUserId);
        if (isOwnerDog && window.userIsAtHome) {
          console.debug('Hiding owner dog marker because user is at home', { dogId: dog.dogId });
          //still add an entry in markers array as null placeholder so UI code that expects markers length doesn't break
          //but do not place it on the map.
          markers.push(null);
          continue;
        }

  const marker = new google.maps.Marker({
          position: { lat, lng: lon },
          map,
          //title fallback: profile.name -> payload name -> deviceId -> generic
          title: (profile && profile.name) || dog.name || dog.deviceId || 'Dog',
          icon: {
            url: (profile && profile.photoUrl) || dog.photoUrl || "https://cdn-icons-png.flaticon.com/512/616/616408.png",
            scaledSize: new google.maps.Size(64, 64),
          },
        });

        const info = new google.maps.InfoWindow({
          content: `<b>${(profile && profile.name) || 'Dog'}</b><br>
                    Age: ${(profile && profile.age) || "N/A"}<br>
                    Breed: ${(profile && profile.breed) || "N/A"}<br>
                    Traits: ${((profile && profile.traits) || []).join(", ")}`,
        });

  marker.addListener("click", () => info.open(map, marker));
  // tag marker with dogId for lookup when clicking pet list
  marker.__dogId = dog.dogId;
  markers.push(marker);
  console.debug('app.js: created marker', { name: (profile && profile.name) || dog.name || dog.deviceId || 'Unnamed', lat, lon, dogId: dog.dogId });
    }
  } catch (err) {
    console.error(err);
  }
}

//create a new dog (used by SPA) - returns JSON
async function createDog(payload) {
  //prevent creating a dog when there's no logged-in user on the client
  if (!window.currentUserId || !window.authToken) {
    console.warn('createDog blocked: no currentUserId set');
    return { success: false, error: 'not-authenticated' };
  }

  //ensure ownerId is present and set from the current session
  const safePayload = Object.assign({}, payload, { ownerId: String(window.currentUserId) });
  const headers = { 'Content-Type': 'application/json', ...(window.authToken ? { 'Authorization': 'Bearer ' + window.authToken } : {}) };
  const res = await fetch('/registerDog', { method: 'POST', headers, body: JSON.stringify(safePayload) });
  return res.json();
}

//update existing dog
async function updateDog(dogId, payload) {
  const headers = { 'Content-Type': 'application/json', ...(window.authToken ? { 'Authorization': 'Bearer ' + window.authToken } : {}) };
  const res = await fetch(`/dog/${dogId}`, { method: 'PUT', headers, body: JSON.stringify(payload) });
  return res.json();
}

//Helper to fetch a single dog profile (used for prefill)
async function getDogProfile(dogId) {
  const res = await fetch(`/dog/${dogId}`);
  return res.json();
}

function initMap() {
  // guard: wait for google.maps to be ready
  if (!(window.google && google.maps && google.maps.Map)) {
    // retry shortly if Maps hasn't initialized yet
    return setTimeout(initMap, 250);
  }
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 40.758, lng: -73.985 },
    zoom: 14,
  });

  //If the page has a current user id (set by signup/login flow), try to center on their home
  (async function tryCenterOnHome() {
    try {
      if (window.currentUserId) {
        const uRes = await fetch(`/user/${window.currentUserId}`);
        const uJson = await uRes.json();
        if (uJson.success && uJson.user && uJson.user.homeLocation) {
          const h = uJson.user.homeLocation;
          if (h && (h.lat || h.lat === 0) && (h.lon || h.lon === 0)) {
            map.setCenter({ lat: Number(h.lat), lng: Number(h.lon) });
            map.setZoom(14);
          }
        }
      }
    } catch (err) {
      console.warn('Could not center map on home', err);
    }
  })();

  loadDogs();
  setInterval(loadDogs, 5000);
}

//initMap will be invoked once Google Maps library is loaded (via callback in the dynamic loader)

function renderPetList(dogs) {
  const container = document.getElementById(petListContainerId);
  if (!container) return;
  const filtered = window.currentUserId ? dogs.filter(d => (d.profile && d.profile.ownerId) === String(window.currentUserId)) : dogs;
  container.innerHTML = '';
  if (!filtered.length) {
    container.innerHTML = '<div style="padding:8px">No pets registered yet. Register one to see it on the map.</div>';
    return;
  }
  const ul = document.createElement('ul');
  ul.style.listStyle = 'none';
  ul.style.padding = '8px';
  ul.style.margin = '0';
  filtered.forEach(d => {
    const li = document.createElement('li');
    li.style.padding = '8px';
    li.style.borderBottom = '1px solid #eee';
    li.style.cursor = 'pointer';
 
  li.textContent = (d.profile && d.profile.name) ? d.profile.name : (d.name || d.deviceId || 'Unnamed');
    li.dataset.dogId = d.dogId;
  // If this is the current user's dog and the user is at home, mark as hidden
  const ownerIsCurrentUser = window.currentUserId && d.profile && String(d.profile.ownerId) === String(window.currentUserId);
  if (ownerIsCurrentUser && window.userIsAtHome) {
      const hiddenBadge = document.createElement('span');
      hiddenBadge.textContent = ' (hidden while at home)';
      hiddenBadge.style.color = '#777';
      hiddenBadge.style.fontSize = '0.9rem';
      hiddenBadge.style.marginLeft = '8px';
      li.appendChild(hiddenBadge);
    }
    // clicking the li centers the map
    li.onclick = () => {
      const m = markers.find(mk => mk.__dogId && String(mk.__dogId) === String(d.dogId));
      if (m && map) { map.setCenter(m.getPosition()); map.setZoom(15); google.maps.event.trigger(m, 'click'); }
    };

    //view button (read-only)
    const viewBtn = document.createElement('button');
    viewBtn.textContent = 'View';
    viewBtn.style.marginLeft = '8px';
    viewBtn.onclick = async (ev) => {
      ev.stopPropagation();
      try {
        const pj = await getDogProfile(d.dogId);
        if (pj.success && pj.profile) renderDogInfo(pj.profile);
      } catch (err) { console.warn('view failed', err); }
    };

    // determine ownership - only owners may edit/remove
    const isOwner = window.currentUserId && d.profile && String(d.profile.ownerId) === String(window.currentUserId);

    // edit button (only for owner)
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.style.marginLeft = '8px';
    editBtn.onclick = async (ev) => {
      ev.stopPropagation();
      // prefill register form and show it
      try {
        const pj = await getDogProfile(d.dogId);
        if (pj.success && pj.profile) {
          const f = document.getElementById('registerDogForm');
          if (!f) return;
          f.deviceId.value = pj.profile.deviceId || '';
          f.name.value = pj.profile.name || '';
          f.age.value = pj.profile.age || '';
          f.breed.value = pj.profile.breed || '';
          f.traits.value = (pj.profile.traits || []).join(', ');
          //prefill sharePublic checkbox so owner can toggle sharing when editing
          try { f.sharePublic.checked = !!pj.profile.sharePublic; } catch (e) { /* ignore if form missing */ }
          // set edit mode
          f.dataset.editDogId = d.dogId;
          // show register form
          document.getElementById('loginContainer') && (document.getElementById('loginContainer').style.display = 'none');
          document.getElementById('signupContainer') && (document.getElementById('signupContainer').style.display = 'none');
          document.getElementById('registerDogContainer') && (document.getElementById('registerDogContainer').style.display = '');
        }
      } catch (err) { console.warn('prefill failed', err); }
    };

    //remove button (destructive, only for owner)
    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.style.marginLeft = '8px';
    removeBtn.style.background = '#d32f2f';
    removeBtn.style.color = '#fff';
    removeBtn.onclick = async (ev) => {
      ev.stopPropagation();
      if (!window.currentUserId) { alert('You must be logged in to remove a dog.'); return; }
      if (!confirm('Remove this dog and all its stored locations? This cannot be undone.')) return;
      try {
        // Use query param for requesterId to avoid preflight and make server handling simpler
  const url = `/dog/${d.dogId}`;
  const headers = { ...(window.authToken ? { 'Authorization': 'Bearer ' + window.authToken } : {}) };
  const res = await fetch(url, { method: 'DELETE', headers });

        if (res.ok) {
          // Try to parse JSON if present; if parsing fails, still treat 2xx as success
          let json = null;
          try { json = await res.json(); } catch (e) { /* non-JSON response - treat as success */ }
          if (json && json.success === false) {
            alert('Remove failed: ' + (json.error || 'unknown'));
          } else {
            //refresh map/list
            loadDogs();
          }
        } else {
          let text = null;
          try { text = await res.text(); } catch (e) { /* ignore */ }
          alert('Remove failed: ' + (text || res.statusText || res.status));
        }
      } catch (err) {
        console.error('Remove network error', err);
        // avoid a blocking alert on transient network/parse issues; refresh UI to reflect server state
        loadDogs();
      }
    };

    li.appendChild(viewBtn);
    if (isOwner) {
      li.appendChild(editBtn);
      li.appendChild(removeBtn);
    }
    ul.appendChild(li);
  });
  container.appendChild(ul);
}

// Render a read-only info panel for a dog
function renderDogInfo(profile) {
  const c = document.getElementById('dogInfoContainer');
  if (!c) return;
  c.style.display = '';
  const traits = (profile.traits || []).length ? (profile.traits || []).join(', ') : 'N/A';
  c.innerHTML = `
    <div style="display:flex; gap:12px; align-items:center;">
      <!-- circular orange-framed photo -->
      <div style="flex:0 0 96px; display:flex; align-items:center; justify-content:center;">
        <div style="width:86px; height:86px; border-radius:50%; background:linear-gradient(135deg,#ffb347 0%,#ff9800 100%); padding:4px; display:flex; align-items:center; justify-content:center; box-shadow:0 6px 14px rgba(0,0,0,0.08);">
          <div style="width:100%; height:100%; border-radius:50%; overflow:hidden; background:#fff; display:flex; align-items:center; justify-content:center;">
            <img src="${profile.photoUrl || 'https://cdn-icons-png.flaticon.com/512/616/616408.png'}" style="width:100%; height:100%; object-fit:cover; display:block;" />
          </div>
        </div>
      </div>
      <div style="flex:1">
        <div style="font-weight:700; font-size:1.1rem;">${profile.name || 'Unnamed'}</div>
        <div>Device ID: <code style="background:#fff8e1; padding:2px 6px; border-radius:4px;">${profile.deviceId || '—'}</code></div>
        <div>Age: ${profile.age || 'N/A'}</div>
        <div>Breed: ${profile.breed || 'N/A'}</div>
        <div>Traits: ${traits}</div>
      </div>
      <div style="flex:0 0 120px; text-align:right">
        <button onclick="(function(){ var el=document.getElementById('dogInfoContainer'); if(el && window.hideElement) window.hideElement(el); else if(el) el.style.display='none'; })()">Close</button>
      </div>
    </div>
  `;
  // ensure visible via helper
  try { if (window && window.showElement) window.showElement(c); else { c.classList.remove('hidden-by-transition'); c.classList.add('visible-by-transition'); c.style.display = ''; } } catch(e){ c.style.display=''; }
}
