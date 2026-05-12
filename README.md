# Habit Tracker PWA

A simple, extensible habit tracker that installs on your iPhone like a native app.

---

## Project structure

```
habit-tracker/
├── index.html      # App shell & UI
├── app.js          # All logic (storage, stats, rendering)
├── manifest.json   # PWA manifest (makes it installable)
├── sw.js           # Service worker (offline support)
├── icons/          # App icons (you need to add these)
│   ├── icon-192.png
│   └── icon-512.png
└── README.md
```

---

## Step 1 — Add app icons

You need two square PNG icons. The easiest way:

1. Go to https://favicon.io/emoji-favicons/
2. Search for an emoji you like (e.g. "target" 🎯)
3. Download the zip and grab the `android-chrome-192x192.png` and `android-chrome-512x512.png`
4. Rename them to `icon-192.png` and `icon-512.png`
5. Put them in an `icons/` folder inside your project

---

## Step 2 — Push to GitHub

```bash
cd habit-tracker

# Initialize git repo (first time only)
git init
git add .
git commit -m "Initial habit tracker"

# Create a new repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/habit-tracker.git
git branch -M main
git push -u origin main
```

---

## Step 3 — Deploy with Vercel (free)

1. Go to https://vercel.com and sign up with your GitHub account
2. Click **"Add New Project"**
3. Import your `habit-tracker` repository
4. Leave all settings as default — click **Deploy**
5. Vercel gives you a URL like `https://habit-tracker-abc123.vercel.app`

That's it — your app is live! 🎉

---

## Step 4 — Install on iPhone

1. Open Safari on your iPhone
2. Go to your Vercel URL
3. Tap the **Share** button (box with arrow)
4. Scroll down and tap **"Add to Home Screen"**
5. Tap **Add**

The app now appears on your home screen like a native app, with no browser UI!

---

## Adding new goals

In the app, tap **Goals** (bottom nav) → **Add new goal**.  
Each goal has its own log, streak, and charts in the Stats tab.

---

## Notes

- All data is stored locally on your device (localStorage)
- Data does NOT sync across devices — it stays on whichever phone/browser you use
- If you want cross-device sync in the future, we can add a simple backend (e.g. Supabase)
