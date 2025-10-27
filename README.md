
# MediaKey

A zero-storage social media downloader for creators.

🔗 Live: https://mediakey.onrender.com

Built with Node.js + yt-dlp + Docker.


🚀 Next Steps

Replace your current server.js with this one
Do NOT commit node_modules:
bash


1
2
git rm -r --cached node_modules
echo "node_modules/" >> .gitignore
Commit and push:
bash


1
2
3
git add .
git commit -m "fix: final MediaKey with universal playback, proper filenames, IG/FB support"
git push origin main
Redeploy on Render → it will auto-update