/**
 * Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Auth, AUTH_MODE } from '../../src/helpers/auth';

describe('Auth Helper', () => {
  const sampleServiceAccount = {
    project_id: 'test-project',
    private_key: '-----BEGIN PRIVATE KEY-----\\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----\\n',
    client_email: 'test-sa@test-project.iam.gserviceaccount.com',
  };

  const sampleServiceAccountWithSubject = {
    ...sampleServiceAccount,
    user_email: 'admin@example.com',
  };

  let mockScriptProperties: Record<string, string>;
  let mockOAuthService: any;

  beforeEach(() => {
    mockScriptProperties = {};

    (global as any).PropertiesService = {
      getScriptProperties: () => ({
        getProperty: (key: string) => mockScriptProperties[key] ?? null,
        setProperty: (key: string, value: string) => {
          mockScriptProperties[key] = value;
        },
      }),
    };

    (global as any).ScriptApp = {
      getOAuthToken: jest.fn().mockReturnValue('mock-user-oauth-token'),
    };

    mockOAuthService = {
      setTokenUrl: jest.fn().mockReturnThis(),
      setPrivateKey: jest.fn().mockReturnThis(),
      setIssuer: jest.fn().mockReturnThis(),
      setSubject: jest.fn().mockReturnThis(),
      setPropertyStore: jest.fn().mockReturnThis(),
      setParam: jest.fn().mockReturnThis(),
      setScope: jest.fn().mockReturnThis(),
      reset: jest.fn().mockReturnThis(),
      getAccessToken: jest.fn().mockReturnValue('mock-sa-access-token'),
    };

    (global as any).OAuth2 = {
      createService: jest.fn().mockReturnValue(mockOAuthService),
    };
  });

  afterEach(() => {
    delete (global as any).PropertiesService;
    delete (global as any).ScriptApp;
    delete (global as any).OAuth2;
  });

  describe('Initialization & Mode Resolution', () => {
    it('defaults to USER mode when no account and no Script Property is provided', () => {
      const auth = new Auth();
      expect(auth.authMode).toBe(AUTH_MODE.USER);
      expect(auth.serviceAccount).toBeUndefined();
    });

    it('resolves SERVICE_ACCOUNT mode from Script Properties when serviceAccount is set', () => {
      mockScriptProperties['serviceAccount'] = JSON.stringify(sampleServiceAccount);

      const auth = new Auth();
      expect(auth.authMode).toBe(AUTH_MODE.SERVICE_ACCOUNT);
      expect(auth.serviceAccount).toBeDefined();
      expect(auth.serviceAccount?.client_email).toBe(sampleServiceAccount.client_email);
    });

    it('resolves SERVICE_ACCOUNT mode from Script Properties under SERVICE_ACCOUNT key', () => {
      mockScriptProperties['SERVICE_ACCOUNT'] = JSON.stringify(sampleServiceAccount);

      const auth = new Auth();
      expect(auth.authMode).toBe(AUTH_MODE.SERVICE_ACCOUNT);
      expect(auth.serviceAccount?.client_email).toBe(sampleServiceAccount.client_email);
    });

    it('resolves SERVICE_ACCOUNT mode from string parameter (JSON parsed)', () => {
      const auth = new Auth(JSON.stringify(sampleServiceAccount));
      expect(auth.authMode).toBe(AUTH_MODE.SERVICE_ACCOUNT);
      expect(auth.serviceAccount?.client_email).toBe(sampleServiceAccount.client_email);
    });

    it('resolves SERVICE_ACCOUNT mode from object parameter', () => {
      const auth = new Auth(sampleServiceAccount);
      expect(auth.authMode).toBe(AUTH_MODE.SERVICE_ACCOUNT);
      expect(auth.serviceAccount?.client_email).toBe(sampleServiceAccount.client_email);
    });

    it('throws an error if string account parameter is invalid JSON', () => {
      expect(() => new Auth('{ invalid-json')).toThrow('Failed to parse service account JSON');
    });
  });

  describe('getAuthToken', () => {
    it('returns ScriptApp user token in USER mode', () => {
      const auth = new Auth();
      const token = auth.getAuthToken();

      expect((global as any).ScriptApp.getOAuthToken).toHaveBeenCalled();
      expect(token).toBe('mock-user-oauth-token');
    });

    it('generates Service Account token and normalizes \\n in private key', () => {
      const auth = new Auth(sampleServiceAccount);
      const token = auth.getAuthToken();

      expect((global as any).OAuth2.createService).toHaveBeenCalledWith('Service Account');
      const expectedNormalizedKey =
        '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';
      expect(mockOAuthService.setPrivateKey).toHaveBeenCalledWith(expectedNormalizedKey);
      expect(mockOAuthService.setIssuer).toHaveBeenCalledWith(sampleServiceAccount.client_email);
      expect(mockOAuthService.setScope).toHaveBeenCalledWith('https://www.googleapis.com/auth/display-video');
      expect(mockOAuthService.setSubject).not.toHaveBeenCalled();
      expect(token).toBe('mock-sa-access-token');
    });

    it('sets subject when user_email is present for domain-wide delegation', () => {
      const auth = new Auth(sampleServiceAccountWithSubject);
      auth.getAuthToken();

      expect(mockOAuthService.setSubject).toHaveBeenCalledWith('admin@example.com');
    });

    it('applies custom scope when requested (e.g. for Google Ads)', () => {
      const auth = new Auth(sampleServiceAccount, 'https://www.googleapis.com/auth/adwords');
      auth.getAuthToken();

      expect(mockOAuthService.setScope).toHaveBeenCalledWith('https://www.googleapis.com/auth/adwords');
    });

    it('throws error when in SERVICE_ACCOUNT mode without private_key', () => {
      const auth = new Auth({ client_email: 'test@example.com' } as any);
      expect(() => auth.getAuthToken()).toThrow('No or invalid service account provided');
    });
  });
});
