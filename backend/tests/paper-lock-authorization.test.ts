import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = randomBytes(32).toString('hex');

const { registerWorksheetRoutes } = await import('../src/routes/worksheets');
const { registerDiagnosticBulkRoutes } = await import('../src/routes/diagnosticBulk');
const { dbStore, UserRole } = await import('../src/db');
const { JWT_SECRET } = await import('../src/auth');
const { recordStudentCycleLock } = await import('../src/paperLock');

const app = express();
app.use(express.json());
registerWorksheetRoutes(app);
registerDiagnosticBulkRoutes(app);

const server = app.listen(0, '127.0.0.1');
let base: string;

before(async () => {
  if (!server.listening) {
    await new Promise<void>(resolve => server.once('listening', resolve));
  }
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve());
}));

const routes = [
  '/api/diagnostic/single',
  '/api/worksheets/generate-level-pdf',
];

for (const route of routes) {
  for (const scenario of ['unknown', 'forbidden', 'existing-lock'] as const) {
    test(`${route}: ${scenario}`, async t => {
      const user = {
        id: 'teacher-1',
        email: 'teacher@example.test',
        role: UserRole.TEACHER,
        schoolId: 'school-1',
      };

      const student = {
        id: 'student-1',
        name: 'Test Student',
        teacherId: 'teacher-2',
        schoolId: scenario === 'forbidden' ? 'school-2' : 'school-1',
        classGroup: 'Class 2',
        currentLevel: 61,
        currentSubLevel: 0,
      };

      t.mock.method(dbStore, 'getUserSync', () => user);
      t.mock.method(dbStore, 'getStudentById', async () =>
        scenario === 'unknown' ? undefined : student);
      t.mock.method(dbStore, 'getStudents', async () =>
        scenario === 'unknown' ? [] : [student]);

      // Build an existing lock using the application's own helper.
      const result = recordStudentCycleLock([], {
        studentId: student.id,
        paperType: 'diagnostic',
        cycle: 'Baseline',
        generatedByEmail: user.email,
        generatedByRole: user.role,
      });
      assert.ok(result.ok);

      const getLocks = t.mock.method(
        dbStore,
        'getStudentCycleLocks',
        async () => [result.lock],
      );
      const addLock = t.mock.method(
        dbStore,
        'addStudentCycleLock',
        async () => {},
      );

      const token = jwt.sign(
        { email: user.email },
        JWT_SECRET,
        { expiresIn: '1m' },
      );

      const response = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          studentId: student.id,
          className: 'Class 2',
        }),
      });
      const body = await response.json() as { error?: string };

      const expectedStatus =
        scenario === 'unknown' ? 404 :
        scenario === 'forbidden' ? 403 : 409;

      assert.equal(response.status, expectedStatus, JSON.stringify(body));
      assert.equal(addLock.mock.callCount(), 0, 'no lock is written');

      if (scenario === 'existing-lock') {
        assert.equal(getLocks.mock.callCount(), 1);
        assert.match(body.error || '', /Lock Active/);
      } else {
        assert.equal(
          getLocks.mock.callCount(),
          0,
          'rejected requests must stop before checking locks',
        );
      }
    });
  }
}