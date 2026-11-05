# QueueUp

QueueUp is a mobile-first office-hours queue app for university students and instructors.

## Run on Replit

- Set the `SESSION_SECRET` secret in Replit Secrets before starting the server.
- Run the `Start application` workflow (or `npm start`); the app listens on port 5000.
- SQLite data is stored in `data/queueup.sqlite` and persists across app restarts in this workspace.

No demo accounts or queue entries are created. Students and instructors sign up through the app.

## Local commands

- `npm start` — start the server.
- `npm test` — run the API and queue-flow tests.
