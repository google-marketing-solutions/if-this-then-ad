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

export interface ServiceAccount {
  type?: string;
  project_id?: string;
  private_key_id?: string;
  private_key: string;
  client_email: string;
  client_id?: string;
  auth_uri?: string;
  token_uri?: string;
  auth_provider_x509_cert_url?: string;
  client_x509_cert_url?: string;
  user_email?: string;
}

export enum AUTH_MODE {
  USER = 'USER',
  SERVICE_ACCOUNT = 'SERVICE_ACCOUNT',
}

/**
 * Wrapper class for handling authentication to DV360, Google Ads, and other Google APIs.
 */
export class Auth {
  serviceAccount?: ServiceAccount;
  authMode: AUTH_MODE;
  defaultScope: string;

  /**
   * Set the OAuth configuration.
   * Supported modes:
   * 1. Default User OAuth: Uses the session of the user who runs or sets up the trigger.
   * 2. Script Property Service Account: Place the GCP Service Account JSON in Apps Script
   *    Project Settings > Script Properties under 'serviceAccount'.
   * 3. Row-level Service Account: Passed explicitly via params.serviceAccount.
   *
   * @param {Object|string} [account] Service account object or JSON string (optional)
   * @param {string} [scope] OAuth scope (defaults to DV360)
   */
  constructor(
    account?: Object | string,
    scope = 'https://www.googleapis.com/auth/display-video'
  ) {
    this.defaultScope = scope;
    let resolvedAccount = account;

    // Check Apps Script Script Properties if not passed directly
    if (!resolvedAccount && typeof PropertiesService !== 'undefined') {
      const scriptProps = PropertiesService.getScriptProperties();
      const saProp =
        scriptProps.getProperty('serviceAccount') ||
        scriptProps.getProperty('SERVICE_ACCOUNT') ||
        scriptProps.getProperty('service_account') ||
        scriptProps.getProperty('SERVICE_ACCOUNT_KEY');
      if (saProp) {
        resolvedAccount = saProp;
      }
    }

    if (resolvedAccount) {
      this.authMode = AUTH_MODE.SERVICE_ACCOUNT;
      if (typeof resolvedAccount === 'string') {
        try {
          this.serviceAccount = JSON.parse(resolvedAccount) as ServiceAccount;
        } catch (e) {
          throw new Error(
            `Failed to parse service account JSON: ${(e as Error).message}`
          );
        }
      } else {
        this.serviceAccount = resolvedAccount as ServiceAccount;
      }
    } else {
      this.authMode = AUTH_MODE.USER;
    }
  }

  /**
   * Get Auth Token for OAuth authorization.
   *
   * @param {string} [scope] Optional scope override
   * @returns {string} OAuth Token
   * @throws {Error}
   */
  getAuthToken(scope?: string) {
    if (this.authMode === AUTH_MODE.USER) {
      return ScriptApp.getOAuthToken();
    } else if (
      !this.serviceAccount ||
      !this.serviceAccount.private_key
    ) {
      throw new Error('No or invalid service account provided');
    }

    const tokenScope = scope ?? this.defaultScope;
    // Normalize newlines in private key to avoid 'Invalid argument: key' error in Apps Script crypto
    const privateKey = (this.serviceAccount.private_key || '').replace(
      /\\n/g,
      '\n'
    );

    const service = OAuth2.createService('Service Account')
      .setTokenUrl('https://accounts.google.com/o/oauth2/token')
      .setPrivateKey(privateKey)
      .setIssuer(this.serviceAccount.client_email)
      .setPropertyStore(PropertiesService.getScriptProperties())
      .setParam('access_type', 'offline')
      .setScope(tokenScope);

    if (this.serviceAccount.user_email) {
      service.setSubject(this.serviceAccount.user_email);
    }

    service.reset();
    return service.getAccessToken();
  }
}
