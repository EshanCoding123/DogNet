/*POST /location

GET /location/:deviceId

POST /dog-profile

GET /nearby*/ 

// server.js
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const bodyParser = require("body-parser");
const cors = require("cors");
const jwt = require('jsonwebtoken');
// Optional: GCP Secret Manager client to fetch secrets at runtime (used for GOOGLE_MAPS_KEY)
let secretManagerClient = null;
try {
  const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
  secretManagerClient = new SecretManagerServiceClient();
} catch (e) {
  // dependency may not be present in minimal environments; /config will fallback to env var
  secretManagerClient = null;
}

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// Require JWT secret from environment. Do NOT commit or fallback to a default in production.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required. Set it in your cloud environment.');
  process.exit(1);
}

// ---------------------
// MongoDB connection
// ---------------------
// Use MONGO_URI from environment (expected to be your Atlas connection string).
// Fail fast if missing so deployment environments must provide it.
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('FATAL: MONGO_URI environment variable is required. Set your Atlas connection string in the cloud environment.');
  process.exit(1);
}
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('MongoDB connected');
})
.catch(err => console.error('MongoDB connection error:', err));

// ---------------------
// Schemas
// ---------------------
const userSchema = new mongoose.Schema({
  username: String,
  email: String,
  passwordHash: String,
  homeLocation: { lat: Number, lon: Number },
});

const dogSchema = new mongoose.Schema({
  ownerId: mongoose.Schema.Types.ObjectId,
  deviceId: { type: String, unique: true },
  passwordHash: String,
  name: String,
  age: Number,
  breed: String,
  traits: [String],
  sharePublic: { type: Boolean, default: false },
  photoUrl: String,
});

const locationSchema = new mongoose.Schema({
  dogId: mongoose.Schema.Types.ObjectId,
  lat: Number,
  lon: Number,
  timestamp: { type: Date, default: Date.now },
});

// PublicLocation mirrors the latest public location for dogs that opted-in to sharing.
// This makes /nearby queries simple and ensures toggling sharePublic immediately
// includes/excludes new location posts.
const publicLocationSchema = new mongoose.Schema({
  dogId: mongoose.Schema.Types.ObjectId,
  lat: Number,
  lon: Number,
  timestamp: { type: Date, default: Date.now },
});

const PublicLocation = mongoose.model("PublicLocation", publicLocationSchema);

const User = mongoose.model("User", userSchema);
const Dog = mongoose.model("Dog", dogSchema);
const Location = mongoose.model("Location", locationSchema);

// Haversine distance (meters) - used to determine proximity to owner's home
function haversineMeters(lat1, lon1, lat2, lon2) {
  function toRad(v) { return v * Math.PI / 180; }
  const R = 6371000; // meters
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ---------------------
// Auth routes (simplified, no JWT yet)
// ---------------------
app.post("/signup", async (req, res) => {
  const { username, email, password, homeLat, homeLon } = req.body;
  const passwordHash = await bcrypt.hash(password, 10);

  const user = new User({
    username,
    email,
    passwordHash,
    homeLocation: { lat: homeLat, lon: homeLon },
  });
  await user.save();
  // issue token
  const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ success: true, userId: user._id, token });
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user) return res.status(400).json({ error: "User not found" });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(400).json({ error: "Wrong password" });
  const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ success: true, userId: user._id, token });
});

// auth middleware to validate Authorization: Bearer <token>
function requireAuth(req, res, next) {
  const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!auth) return res.status(401).json({ error: 'Missing Authorization' });
  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return res.status(401).json({ error: 'Bad Authorization format' });
  const token = parts[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ---------------------
// Dog registration
// ---------------------
app.post("/registerDog", requireAuth, async (req, res) => {
  const { deviceId, password, name, age, breed, traits, photoUrl } = req.body;
  if (!password || !deviceId) return res.status(400).json({ error: "Device ID and password required" });
  const existingDog = await Dog.findOne({ deviceId });
  if (existingDog) return res.status(400).json({ error: "Device ID already registered" });
  const passwordHash = await bcrypt.hash(password, 10);
  const dog = new Dog({
    ownerId: req.userId,
    deviceId,
    passwordHash,
    name,
    age,
    breed,
    traits,
    photoUrl,
  });
  await dog.save();
  res.json({ success: true, dogId: dog._id });
});

// Dog login
app.post("/dog-login", async (req, res) => {
  const { deviceId, password } = req.body;
  const dog = await Dog.findOne({ deviceId });
  if (!dog) return res.status(400).json({ error: "Dog not found" });
  const valid = await bcrypt.compare(password, dog.passwordHash);
  if (!valid) return res.status(400).json({ error: "Wrong password" });
  res.json({ success: true, dogId: dog._id });
});

// Dog photo upload
const multer = require("multer");
const path = require("path");
const upload = multer({
  dest: path.join(__dirname, "uploads/"),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed!"));
  },
});
app.post("/upload-dog-photo", upload.single("photo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  // For demo, serve from /uploads/ (ensure static serving in production)
  const url = `/uploads/${req.file.filename}`;
  res.json({ url });
});
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ...existing code...

// ---------------------
// GPS location posting
// ---------------------
app.post("/location", async (req, res) => {
  const { deviceId, lat, lon } = req.body;
  const dog = await Dog.findOne({ deviceId });
  if (!dog) return res.status(400).json({ error: "Dog not registered" });

  const loc = new Location({ dogId: dog._id, lat, lon });
  await loc.save();
  console.debug('Saved location for deviceId=%s dogId=%s lat=%s lon=%s', deviceId, dog._id, lat, lon); //DEBUGGING
  // If the dog is sharing publicly, upsert the latest public location so /nearby
  // can query a compact collection. If not sharing, ensure any stored public
  // location is removed.
  try {
    const HOME_THRESHOLD_METERS = Number(process.env.HOME_THRESHOLD_METERS) || 50;
    if (dog.sharePublic) {
      // check owner's home and hide public location if the new location is inside the home radius
      let owner = null;
      try {
        if (dog.ownerId) owner = await User.findById(dog.ownerId).lean();
      } catch (e) { /* ignore */ }

      let insideOwnerHome = false;
      if (owner && owner.homeLocation && owner.homeLocation.lat != null && owner.homeLocation.lon != null) {
        try {
          const dist = haversineMeters(Number(owner.homeLocation.lat), Number(owner.homeLocation.lon), Number(lat), Number(lon));
          if (dist <= HOME_THRESHOLD_METERS) {
            insideOwnerHome = true;
            //console.debug('Location is inside owner home; removing PublicLocation for dog', dog._id, 'distMeters=', dist);
          }
        } catch (e) { console.warn('Failed to compute distance to owner home', e); }
      }

      if (insideOwnerHome) {
        // ensure no public record exists while dog is at home
        await PublicLocation.deleteOne({ dogId: dog._id });
      } else {
        await PublicLocation.findOneAndUpdate(
          { dogId: dog._id },
          { dogId: dog._id, lat: Number(lat), lon: Number(lon), timestamp: new Date() },
          { upsert: true, new: true }
        );
      }
    } else {
      // remove any stale public location for privacy
      await PublicLocation.deleteOne({ dogId: dog._id });
    }
  } catch (err) {
    console.error('PublicLocation maintenance failed', err);
  }

  res.json({ success: true, location: loc });
});

// ---------------------
// GET all dog locations
// ---------------------
app.get("/locations", async (req, res) => {
  try {
    // Optional auth: if caller provides a valid Bearer token, treat them as that user.
    let requesterId = null;
    try {
      const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
      if (auth) {
        const parts = auth.split(' ');
        if (parts.length === 2 && parts[0] === 'Bearer') {
          const payload = jwt.verify(parts[1], JWT_SECRET);
          requesterId = payload && payload.userId;
        }
      }
    } catch (e) { /* ignore invalid token */ }

    const dogs = await Dog.find();
    const latestLocations = await Location.aggregate([
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: "$dogId",
          lat: { $first: "$lat" },
          lon: { $first: "$lon" },
          timestamp: { $first: "$timestamp" },
        },
      },
    ]);

    // Preload owners to inspect homeLocation for privacy filtering
    const ownerIds = Array.from(new Set(dogs.map(d => d.ownerId && d.ownerId.toString()).filter(Boolean)));
    const owners = ownerIds.length ? await User.find({ _id: { $in: ownerIds } }).lean() : [];
    const ownersById = {};
    owners.forEach(o => { ownersById[o._id.toString()] = o; });

    const HOME_THRESHOLD_METERS = Number(process.env.HOME_THRESHOLD_METERS) || 50;

    const dogData = [];
    for (const dog of dogs) {
      const loc = latestLocations.find((l) => l._id.toString() === dog._id.toString());

      // Determine visibility: owners always see their dogs; others only see dogs that opted into sharing
      const isOwner = requesterId && dog.ownerId && String(dog.ownerId) === String(requesterId);
      if (!isOwner) {
        if (!dog.sharePublic) {
          // not sharing publicly -> skip for non-owners
          continue;
        }

        // if we have an owner's home location and a latest location, hide public marker when inside home threshold
        const owner = dog.ownerId ? ownersById[String(dog.ownerId)] : null;
        if (owner && owner.homeLocation && loc && loc.lat != null && loc.lon != null) {
          const dist = haversineMeters(owner.homeLocation.lat, owner.homeLocation.lon, Number(loc.lat), Number(loc.lon));
          if (dist <= HOME_THRESHOLD_METERS) {
            // treat as private while at home
            continue;
          }
        }
      }

      dogData.push({
        dogId: dog._id,
        deviceId: dog.deviceId,
        lat: loc?.lat,
        lon: loc?.lon,
        profile: {
          name: dog.name,
          age: dog.age,
          breed: dog.breed,
          traits: dog.traits,
          photoUrl: dog.photoUrl,
          sharePublic: !!dog.sharePublic,
          ownerId: dog.ownerId ? dog.ownerId.toString() : null,
        },
      });
    }

    console.debug('Returning /locations payload:', JSON.stringify(dogData, null, 2));
    res.json(dogData);
  } catch (err) {
    console.error('GET /locations error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Return dog profile by id
app.get('/dog/:id', async (req, res) => {
  try {
    const dog = await Dog.findById(req.params.id).lean();
    if (!dog) return res.status(404).json({ error: 'Dog not found' });
    const profile = {
      name: dog.name,
      age: dog.age,
      breed: dog.breed,
      traits: dog.traits,
      photoUrl: dog.photoUrl,
      deviceId: dog.deviceId,
  sharePublic: !!dog.sharePublic,
      ownerId: dog.ownerId,
    };
    res.json({ success: true, profile });
  } catch (err) {
    console.error('GET /dog/:id error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update dog profile (owner must match)
app.put('/dog/:id', requireAuth, async (req, res) => {
  try {
    const { name, age, breed, traits, photoUrl, deviceId } = req.body;
    const dog = await Dog.findById(req.params.id);
    if (!dog) return res.status(404).json({ error: 'Dog not found' });
    // verify owner using token-derived user
    if (!req.userId || dog.ownerId?.toString() !== String(req.userId)) return res.status(403).json({ error: 'Not allowed' });

    // if deviceId changes, ensure uniqueness
    if (deviceId && deviceId !== dog.deviceId) {
      const existing = await Dog.findOne({ deviceId });
      if (existing) return res.status(400).json({ error: 'Device ID already registered' });
      dog.deviceId = deviceId;
    }
    if (name !== undefined) dog.name = name;
    if (age !== undefined) dog.age = age;
    if (breed !== undefined) dog.breed = breed;
    if (traits !== undefined) dog.traits = Array.isArray(traits) ? traits : (typeof traits === 'string' ? traits.split(',').map(t=>t.trim()) : dog.traits);
    if (photoUrl !== undefined) dog.photoUrl = photoUrl;
    if (req.body.sharePublic !== undefined) dog.sharePublic = !!req.body.sharePublic;

    await dog.save();

    // Maintain PublicLocation when sharePublic changed via the general update endpoint.
    // This mirrors the behavior of POST /dog/:id/share so editing the dog form
    // correctly enables/disables public visibility.
    try {
      if (req.body.sharePublic !== undefined) {
        if (dog.sharePublic) {
          const latest = await Location.findOne({ dogId: dog._id }).sort({ timestamp: -1 }).lean();
          if (latest) {
            await PublicLocation.findOneAndUpdate(
              { dogId: dog._id },
              { dogId: dog._id, lat: Number(latest.lat), lon: Number(latest.lon), timestamp: latest.timestamp || new Date() },
              { upsert: true, new: true }
            );
          }
        } else {
          await PublicLocation.deleteOne({ dogId: dog._id });
        }
      }
    } catch (err) {
      console.error('PUT /dog/:id publicLocation maintenance failed', err);
    }

    res.json({ success: true, dogId: dog._id, profile: { name: dog.name, age: dog.age, breed: dog.breed, traits: dog.traits, photoUrl: dog.photoUrl, deviceId: dog.deviceId, ownerId: dog.ownerId } });
  } catch (err) {
    console.error('PUT /dog/:id error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle public sharing for a dog's owner (same as update but simple endpoint)
app.post('/dog/:id/share', requireAuth, async (req, res) => {
  try {
    const dog = await Dog.findById(req.params.id);
    if (!dog) return res.status(404).json({ error: 'Dog not found' });
    if (!req.userId || dog.ownerId?.toString() !== String(req.userId)) return res.status(403).json({ error: 'Not allowed' });
    const enable = !!req.body.sharePublic;
    dog.sharePublic = enable;
    await dog.save();

    // If enabling, try to copy the latest stored Location into PublicLocation so
    // the dog immediately appears in /nearby. If disabling, remove public loc.
    try {
      if (enable) {
        const latest = await Location.findOne({ dogId: dog._id }).sort({ timestamp: -1 }).lean();
        if (latest) {
          await PublicLocation.findOneAndUpdate(
            { dogId: dog._id },
            { dogId: dog._id, lat: Number(latest.lat), lon: Number(latest.lon), timestamp: latest.timestamp || new Date() },
            { upsert: true, new: true }
          );
        }
      } else {
        await PublicLocation.deleteOne({ dogId: dog._id });
      }
    } catch (err) {
      console.error('sharePublic toggle publicLocation maintenance failed', err);
    }

    res.json({ success: true, sharePublic: dog.sharePublic });
  } catch (err) {
    console.error('POST /dog/:id/share error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Nearby public dogs: accepts lat, lon, radiusMeters (optional, default 2000)
app.post('/nearby', async (req, res) => {
  try {
    // Accept lat/lon of the querying device, a search radius, and an optional debug flag
    const { lat, lon, radiusMeters = 2000, debug = false, homeThresholdMeters = 50 } = req.body || {};

    // Maintenance: ensure PublicLocation has entries for all dogs that have sharePublic === true.
    try {
      const sharingDogs = await Dog.find({ sharePublic: true }).lean();
      if (sharingDogs && sharingDogs.length) {
        const sharingIds = sharingDogs.map(d => d._id);
        const existingPublic = await PublicLocation.find({ dogId: { $in: sharingIds } }).lean();
        const existingMap = new Map(existingPublic.map(p => [String(p.dogId), p]));
        for (const dog of sharingDogs) {
          const key = String(dog._id);
          const pub = existingMap.get(key);
          const latest = await Location.findOne({ dogId: dog._id }).sort({ timestamp: -1 }).lean();
          if (!latest) continue;
          const latestTs = new Date(latest.timestamp || Date.now()).getTime();
          const pubTs = pub ? new Date(pub.timestamp || 0).getTime() : 0;
          if (!pub || latestTs > pubTs) {
            await PublicLocation.findOneAndUpdate(
              { dogId: dog._id },
              { dogId: dog._id, lat: Number(latest.lat), lon: Number(latest.lon), timestamp: latest.timestamp || new Date() },
              { upsert: true, new: true }
            );
          }
        }
      }
    } catch (err) {
      console.error('Error maintaining PublicLocation entries before nearby:', err);
    }

    // Defensive cleanup: remove any PublicLocation entries for dogs that no longer share
    try {
      const allPublic = await PublicLocation.find().lean();
      if (allPublic && allPublic.length) {
        const pubDogIds = allPublic.map(p => p.dogId);
        const dogsForPub = await Dog.find({ _id: { $in: pubDogIds } }).lean();
        const shareMap = new Map(dogsForPub.map(d => [String(d._id), !!d.sharePublic]));
        const staleIds = allPublic.filter(p => !shareMap.get(String(p.dogId))).map(p => p._id);
        if (staleIds.length) await PublicLocation.deleteMany({ _id: { $in: staleIds } });
      }
    } catch (err) {
      console.error('Error cleaning stale PublicLocation entries before nearby:', err);
    }

    // Read the (now-maintained) PublicLocation collection
    const publicLocations = await PublicLocation.find().lean();

    // preload dogs and owners to avoid N+1 queries
    const dogIds = publicLocations.map(p => String(p.dogId));
    const dogs = await Dog.find({ _id: { $in: dogIds } }).lean();
    const dogById = {};
    const ownerIds = new Set();
    for (const d of dogs) {
      dogById[String(d._id)] = d;
      if (d.ownerId) ownerIds.add(String(d.ownerId));
    }
    const owners = await User.find({ _id: { $in: Array.from(ownerIds) } }).lean();
    const ownerById = {};
    for (const o of owners) ownerById[String(o._id)] = o;

    const results = [];
    const debugEntries = [];

    for (const p of publicLocations) {
      const pid = String(p.dogId);
      const dog = dogById[pid];
      if (!dog) {
        if (debug) debugEntries.push({ publicLocation: p, reason: 'missing_dog' });
        continue;
      }

      // Exclude public locations that are inside the dog's owner's home
      let insideOwnerHome = false;
      if (dog.ownerId) {
        const owner = ownerById[String(dog.ownerId)];
        if (owner && owner.homeLocation && owner.homeLocation.lat != null && owner.homeLocation.lon != null) {
          try {
            const distToHome = haversineMeters(p.lat, p.lon, Number(owner.homeLocation.lat), Number(owner.homeLocation.lon));
            if (distToHome <= Number(homeThresholdMeters)) {
              insideOwnerHome = true;
              if (debug) debugEntries.push({ publicLocation: p, dogId: pid, reason: 'inside_owner_home', distToHome });
            }
          } catch (e) {
            if (debug) debugEntries.push({ publicLocation: p, dogId: pid, reason: 'home_distance_error', error: String(e) });
          }
        }
      }
      if (insideOwnerHome) continue;

      // If caller supplied a lat/lon, compute distance to the querying device and filter by radius
      let distanceMeters = null;
      if (lat != null && lon != null) {
        try { distanceMeters = haversineMeters(Number(lat), Number(lon), Number(p.lat), Number(p.lon)); } catch (e) { if (debug) debugEntries.push({ publicLocation: p, dogId: pid, reason: 'distance_calc_error', error: String(e) }); continue; }
        if (distanceMeters > Number(radiusMeters)) { if (debug) debugEntries.push({ publicLocation: p, dogId: pid, reason: 'out_of_radius', distanceMeters }); continue; }
      }

      results.push({ dogId: pid, lat: p.lat, lon: p.lon, timestamp: p.timestamp, profile: { name: dog.name, age: dog.age, breed: dog.breed, traits: dog.traits, photoUrl: dog.photoUrl, sharePublic: !!dog.sharePublic }, distanceMeters });
    }

    const payload = { success: true, count: results.length, results };
    if (debug) payload.debugEntries = debugEntries;
    res.json(payload);
  } catch (err) {
    console.error('POST /nearby error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete dog (owner only) - also remove stored locations for cleanup
app.delete('/dog/:id', requireAuth, async (req, res) => {
  try {
    const dog = await Dog.findById(req.params.id);
    if (!dog) return res.status(404).json({ error: 'Dog not found' });
    if (!req.userId || dog.ownerId?.toString() !== String(req.userId)) return res.status(403).json({ error: 'Not allowed' });

    //remove dog and associated locations
    await Dog.deleteOne({ _id: dog._id });
    await Location.deleteMany({ dogId: dog._id });

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /dog/:id error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Return user by id (used to get home location)
app.get('/user/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, user: { username: user.username, homeLocation: user.homeLocation } });
  } catch (err) {
    console.error('GET /user/:id error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Expose minimal runtime config to the client. Only include non-sensitive values
// that the browser needs (for example, the Google Maps API key). Do NOT expose
// server secrets such as JWT_SECRET or database credentials here.
// If GOOGLE_MAPS_SECRET_NAME is set, the server will try to read the secret from
// GCP Secret Manager and cache it in-memory. Otherwise it will use
// process.env.GOOGLE_MAPS_KEY (if provided).
let _cachedGoogleMapsKey = null;
async function loadGoogleMapsKey() {
  if (_cachedGoogleMapsKey) return _cachedGoogleMapsKey;
  //Preferred: read from Secret Manager if a secret name is configured
  const secretName = process.env.GOOGLE_MAPS_SECRET_NAME;
  if (secretName && secretManagerClient) {
    try {
      //secretName should be the full resource name: projects/<project>/secrets/<name>/versions/latest
      const [accessResp] = await secretManagerClient.accessSecretVersion({ name: secretName });
      const payload = accessResp.payload && accessResp.payload.data ? accessResp.payload.data.toString('utf8') : '';
      if (payload) {
        _cachedGoogleMapsKey = payload.trim();
        return _cachedGoogleMapsKey;
      }
    } catch (err) {
      console.error('Failed to read Google Maps key from Secret Manager', err);
    }
  }
  //Fallback to env var
  _cachedGoogleMapsKey = process.env.GOOGLE_MAPS_KEY || '';
  return _cachedGoogleMapsKey;
}

app.get('/config', async (req, res) => {
  try {
    const key = await loadGoogleMapsKey();
    res.json({ googleMapsKey: key });
  } catch (err) {
    console.error('GET /config error', err);
    res.json({ googleMapsKey: process.env.GOOGLE_MAPS_KEY || '' });
  }
});


//Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});

