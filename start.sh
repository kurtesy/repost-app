kill -9 $(lsof -i :3011 | grep node | awk '{print $2}')
kill -9 $(lsof -i :8088 | grep node | awk '{print $2}')
cd ytdlp-helper
nohup npm run start &
cd ..
npm run start &
kill -9 $(lsof -i :3011 | grep node | awk '{print $2}')
kill -9 $(lsof -i :8088 | grep node | awk '{print $2}')