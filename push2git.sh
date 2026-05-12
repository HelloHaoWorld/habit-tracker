# Initialize git repo (first time only)
git init
git add .
git commit -m "Initial habit tracker"

# Create a new repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/habit-tracker.git
git branch -M main
git push -u origin main
