import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import postgres from 'postgres';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { loadConfig } from '../src/core/config';
import { APP_PASSWORD, TEST_DB } from './global-setup';

function urlFor(user: string, password: string): string {
  const url = new URL(process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres');
  url.username = user;
  url.password = password;
  url.pathname = `/${TEST_DB}`;
  return url.toString();
}

export const appDatabaseUrl = () => urlFor('pos_app', APP_PASSWORD);

export function adminSql() {
  const admin = new URL(process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres');
  return postgres(urlFor(decodeURIComponent(admin.username), decodeURIComponent(admin.password)), { max: 1, onnotice: () => {} });
}

export async function createTestApp(): Promise<INestApplication> {
  const config = loadConfig({
    DATABASE_URL: appDatabaseUrl(),
    AUTH_MODE: 'dev',
    AUTH_DEV_SECRET: 'test-secret-test-secret-test-secret-123',
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  // Listening once lets supertest reuse the server instead of binding per request.
  await app.listen(0);
  return app;
}

let counter = 0;
export const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** A signed-in user with helpers for calling the API, optionally inside a business. */
export class Client {
  tenantId?: string;
  /** Sent as X-Device-Credential, as a paired handheld or register would. */
  deviceCredential?: string;
  private constructor(
    private readonly app: INestApplication,
    readonly token: string,
    readonly email: string,
  ) {}

  static async signIn(app: INestApplication, email = `${unique('user')}@example.com`): Promise<Client> {
    const res = await request(app.getHttpServer()).post('/dev/token').send({ email }).expect(201);
    return new Client(app, res.body.token, email);
  }

  private req(method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string) {
    let r = request(this.app.getHttpServer())[method](path).set('Authorization', `Bearer ${this.token}`);
    if (this.tenantId) r = r.set('X-Tenant-Id', this.tenantId);
    if (this.deviceCredential) r = r.set('X-Device-Credential', this.deviceCredential);
    return r;
  }

  get = (path: string) => this.req('get', path);
  post = (path: string, body: object = {}) => this.req('post', path).send(body);
  put = (path: string, body: object = {}) => this.req('put', path).send(body);
  patch = (path: string, body: object = {}) => this.req('patch', path).send(body);
  delete = (path: string) => this.req('delete', path);

  /** Creates a business owned by this user and selects it. */
  async createBusiness(name = 'Test Shop'): Promise<string> {
    const res = await this.post('/tenants', { name, slug: unique('shop') }).expect(201);
    this.tenantId = res.body.id;
    return res.body.id;
  }

  /** Invites `other` with the given role key and returns them, selected into this business. */
  async invite(other: Client, roleKey: string): Promise<Client> {
    const roles = await this.get('/roles').expect(200);
    const role = roles.body.find((r: { key: string }) => r.key === roleKey);
    const inv = await this.post('/invitations', { roleId: role.id }).expect(201);
    await other.post('/invitations/accept', { code: inv.body.code }).expect(201);
    other.tenantId = this.tenantId;
    return other;
  }
}
