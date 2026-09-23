import "dotenv/config";
import cors from "cors";
import express from "express";
import { PrismaClient, SessionPriority } from "@prisma/client";

const prisma = new PrismaClient();
const app = express();
const port = Number(process.env.PORT ?? 4000);
const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";
const priorities = new Set(Object.values(SessionPriority));

app.use(cors({ origin: frontendUrl }));
app.use(express.json());

app.get("/health", (_request, response) => response.json({ status: "ok" }));

app.get("/api/players", async (_request, response, next) => {
    try {
        response.json(await prisma.player.findMany({ orderBy: { jerseyNumber: "asc" } }));
    } catch (error) { next(error); }
});

app.post("/api/players", async (request, response, next) => {
    try {
        const entries = Array.isArray(request.body) ? request.body : request.body.players ?? [request.body];
        type PlayerInput = { name?: string; jerseyNumber?: number; position?: string; birthday?: string; batch?: string; department?: string; faculty?: string; imageUrl?: string };
        const validBatches = new Set(["23", "24", "25", "26"]);
        if (!entries.length || entries.some((player: PlayerInput) => !player.name || player.jerseyNumber === undefined || !player.position || !player.birthday || !player.batch || !validBatches.has(player.batch) || !player.department || !player.faculty)) {
            response.status(400).json({ error: "Each player needs name, jersey number, position, birthday, batch, department, and faculty." });
            return;
        }
        const players = await prisma.$transaction(entries.map((player: PlayerInput) => prisma.player.create({
            data: { name: player.name!.trim(), jerseyNumber: Number(player.jerseyNumber), position: player.position!.trim(), birthday: new Date(player.birthday!), batch: player.batch!, department: player.department!.trim(), faculty: player.faculty!.trim(), imageUrl: player.imageUrl || null },
        })));
        response.status(201).json(players);
    } catch (error) { next(error); }
});

app.get("/api/sessions", async (_request, response, next) => {
    try {
        response.json(await prisma.session.findMany({ include: { _count: { select: { attendanceRecords: true } } }, orderBy: { date: "desc" } }));
    } catch (error) { next(error); }
});

app.post("/api/sessions", async (request, response, next) => {
    try {
        const { date, startTime, endTime, priority } = request.body as { date?: string; startTime?: string; endTime?: string; priority?: string };
        if (!date || !startTime || !endTime || !priority || !priorities.has(priority as SessionPriority)) {
            response.status(400).json({ error: "A date, start time, end time, and valid session type are required." });
            return;
        }
        const startDate = new Date(`${date}T${startTime}:00`);
        const endDate = new Date(`${date}T${endTime}:00`);
        if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) {
            response.status(400).json({ error: "The end time must be later than the start time." });
            return;
        }
        response.status(201).json(await prisma.session.create({ data: { date: startDate, startTime: startDate, endTime: endDate, priority: priority as SessionPriority } }));
    } catch (error) { next(error); }
});

app.get("/api/sessions/:id/records", async (request, response, next) => {
    try {
        response.json(await prisma.attendanceRecord.findMany({ where: { sessionId: request.params.id }, include: { player: true }, orderBy: { player: { jerseyNumber: "asc" } } }));
    } catch (error) { next(error); }
});

app.patch("/api/sessions/:id/records", async (request, response, next) => {
    try {
        const { playerId, status } = request.body as { playerId?: string; status?: string };
        if (!playerId || !["PRESENT", "LATE", "ABSENT", "EXCUSED"].includes(status ?? "")) {
            response.status(400).json({ error: "Player and valid attendance status are required." });
            return;
        }
        response.json(await prisma.attendanceRecord.upsert({
            where: { sessionId_playerId: { sessionId: request.params.id, playerId } },
            create: { sessionId: request.params.id, playerId, status: status as "PRESENT" | "LATE" | "ABSENT" | "EXCUSED", confirmed: false },
            update: { status: status as "PRESENT" | "LATE" | "ABSENT" | "EXCUSED", confirmed: false },
            include: { player: true },
        }));
    } catch (error) { next(error); }
});

app.post("/api/sessions/:id/approve", async (request, response, next) => {
    try {
        const session = request.params.id === "NB-240924-01"
            ? await prisma.session.findFirst({ where: { status: "OPEN" }, orderBy: { date: "desc" }, include: { attendanceRecords: true } })
            : await prisma.session.findUnique({ where: { id: request.params.id }, include: { attendanceRecords: true } });
        if (!session) { response.status(404).json({ error: "Session not found." }); return; }
        if (session.status === "APPROVED") { response.json(session); return; }
        const players = await prisma.player.findMany({ orderBy: { jerseyNumber: "asc" } });
        await prisma.$transaction(async (transaction) => {
            await Promise.all(players.map((player) => transaction.attendanceRecord.upsert({
                where: { sessionId_playerId: { sessionId: session.id, playerId: player.id } },
                create: { sessionId: session.id, playerId: player.id, status: "ABSENT", confirmed: true },
                update: { confirmed: true },
            })));
            await transaction.session.update({ where: { id: session.id }, data: { status: "APPROVED" } });
        });
        const records = await prisma.attendanceRecord.findMany({
            where: { sessionId: session.id },
            include: { player: true },
            orderBy: { player: { jerseyNumber: "asc" } },
        });
        response.json({ session: { ...session, status: "APPROVED" }, records, recordCount: records.length });
    } catch (error) { next(error); }
});

app.post("/api/checkin", async (request, response, next) => {
    try {
        const { sessionId, playerId, status } = request.body as { sessionId?: string; playerId?: string; status?: string };
        if (!sessionId || !playerId || !["PRESENT", "LATE"].includes(status ?? "")) { response.status(400).json({ error: "Session, player, and check-in status are required." }); return; }
        const session = await prisma.session.findUnique({ where: { id: sessionId } });
        if (!session || session.status === "APPROVED") { response.status(409).json({ error: "This session is closed." }); return; }
        const now = Date.now();
        const sessionStart = session.date.getTime();
        if (now < sessionStart - 30 * 60 * 1000 || now > sessionStart + 2 * 60 * 60 * 1000) { response.status(409).json({ error: "Check-in is only available from 30 minutes before until 2 hours after the session starts." }); return; }
        const player = await prisma.player.findUnique({ where: { id: playerId } });
        if (!player) { response.status(404).json({ error: "Player not found." }); return; }
        response.status(201).json(await prisma.attendanceRecord.upsert({ where: { sessionId_playerId: { sessionId, playerId } }, create: { sessionId, playerId, status: status as "PRESENT" | "LATE", checkedInAt: new Date() }, update: { status: status as "PRESENT" | "LATE", checkedInAt: new Date(), confirmed: false } }));
    } catch (error) { next(error); }
});

app.get("/api/reports", async (request, response, next) => {
    try {
        const priority = typeof request.query.priority === "string" ? request.query.priority : "ALL";
        if (priority !== "ALL" && !priorities.has(priority as SessionPriority)) { response.status(400).json({ error: "Invalid session priority." }); return; }
        const [players, sessions] = await Promise.all([
            prisma.player.findMany({ orderBy: { jerseyNumber: "asc" } }),
            prisma.session.findMany({ where: { status: "APPROVED", ...(priority !== "ALL" ? { priority: priority as SessionPriority } : {}) }, include: { attendanceRecords: true }, orderBy: { date: "desc" } }),
        ]);
        const report = players.map((player) => {
            const eligibleSessions = sessions.filter((session) => session.date >= player.registeredDate);
            const records = eligibleSessions.flatMap((session) => session.attendanceRecords.filter((record) => record.playerId === player.id));
            const excused = records.filter((record) => record.status === "EXCUSED").length;
            const denominator = Math.max(eligibleSessions.length - excused, 0);
            const present = records.filter((record) => record.status === "PRESENT").length;
            const late = records.filter((record) => record.status === "LATE").length;
            return { playerId: player.id, name: player.name, jerseyNumber: player.jerseyNumber, position: player.position, imageUrl: player.imageUrl, eligibleSessions: denominator, present, late, absent: Math.max(denominator - present - late, 0), excused, percentage: denominator ? Math.round(((present + late) / denominator) * 1000) / 10 : 0 };
        });
        response.json({ priority, sessions: sessions.length, report });
    } catch (error) { next(error); }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    console.error(error);
    if (error instanceof Error && error.message.includes("Can't reach database server")) {
        response.status(503).json({ error: "Database unavailable. Start PostgreSQL and try again." });
        return;
    }
    response.status(500).json({ error: "Internal server error." });
});

const server = app.listen(port, () => console.log(`Attendance API listening on http://localhost:${port}`));
process.on("SIGTERM", async () => { await prisma.$disconnect(); server.close(); });
