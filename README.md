# Attendance Backend

Standalone Express and Prisma API for the University Football Attendance System.

## Setup

1. Copy `.env.example` to `.env` and set `DATABASE_URL`.
2. Install dependencies with `npm install`.
3. Generate Prisma Client with `npm run prisma:generate`.
4. Create the database tables with `npm run prisma:migrate`.
5. Start the API with `npm run dev`.

The API listens on `http://localhost:4000` by default. The frontend should use `NEXT_PUBLIC_API_URL=http://localhost:4000`.
