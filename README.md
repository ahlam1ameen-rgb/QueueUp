 # QueueUp
 
**QueueUp** is a mobile-first office-hours queue app for university students and instructors.
 
Instead of waiting outside an office or guessing who's next, students join an instructor's queue online, pick the reason for their visit, and wait for their turn. Instructors see the queue and call the next student when they're ready.
 
 Built at the **BuildRush Hackathon 2026** (powered by Replit) at Al Ain University, under the **Students** theme.
 
---
 
## Features
 
- **Student and instructor accounts:** users sign up through the app with their role
- **Join a queue by visit reason:** students choose why they're coming (e.g. a question about an assignment, exam review, grades)
- **Instructor queue view:** instructors see who's waiting and why
- **Call next:** instructors move the queue forward with one action
- **Mobile-first design:** made to be used on a phone
- **Persistent data:** queues and accounts are stored in SQLite and survive restarts
<img width="250"  alt="Screenshot 2026-11-06 223216" src="https://github.com/user-attachments/assets/9c8684d0-1954-46d7-b188-2b0f4b3daf83" />
<img width="250"  alt="Screenshot 2026-11-06 223246" src="https://github.com/user-attachments/assets/cef0bf00-87f5-45ac-8dc2-b7f3acdfc133" />
<img width="252"  alt="image" src="https://github.com/user-attachments/assets/c2f3e201-712a-4254-b9e0-61af56a9a256" />

---

 ## Team
 
Built at BuildRush Hackathon 2026 by:
 
- Ahlam Ameen 
- Sarah Al Jalal
- Yara Wael
- Sadrah Mohammed
- Bana

---

## Tech Stack

- **Backend:** Node.js with Express
- **Authentication:** express-session (session-based login)
- **Database:** SQLite (via better-sqlite3)
- **Hosting / development:** Replit

---
 
## Getting Started
 
1. Add a `SESSION_SECRET` in Replit Secrets (or as an environment variable).
2. Run `npm install`, then `npm start`.
3. Open the app on port 5000.
---
 
## License
 
This project was created for the BuildRush Hackathon and is shared for learning and portfolio purposes.
