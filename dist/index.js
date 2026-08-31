/**
 * Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const GLOBALCTX = this;
const CONFIG = {
    spreadsheetId: null,
    sourceNamespace: 'source',
    targetNamespace: 'target',
    resultNamespace: 'result',
    rules: {
        sheetName: 'Rules',
        startRow: 1,
        cols: {
            ruleName: 0,
            lastUpdate: 1,
            status: 2,
            activationFormula: 3,
            updateInterval: 4,
            targetAgent: 5,
            targetAction: 6,
            targetIdType: 7,
            targetId: 8,
        },
    },
};

class ApiHelper {
    constructor() {
        this.cache = {};
    }
    callApi(url, headers, queryParams, body, method = 'get', contentType = 'application/json', forceCache = false) {
        if (queryParams) {
            url = `${url}${this.objectToUrlQuery(url, queryParams)}`;
        }
        const params = {
            headers: headers ?? {},
            method: method,
            muteHttpExceptions: true,
            contentType: contentType,
        };
        if (body) {
            if (contentType === 'application/json') {
                body = JSON.stringify(body);
            }
            params.payload = body;
        }
        const cacheKey = `${url}-${JSON.stringify(params)}`;
        if (cacheKey in this.cache && this.cache[cacheKey]) {
            console.log('Returning cached result', JSON.stringify(this.cache[cacheKey]));
            return this.cache[cacheKey];
        }
        const resRaw = UrlFetchApp.fetch(url, params);
        if (200 !== resRaw.getResponseCode() && 204 !== resRaw.getResponseCode()) {
            Logger.log('HTTP code: ' + resRaw.getResponseCode());
            Logger.log('API error: ' + resRaw.getContentText());
            Logger.log('URL: ' + url);
            Logger.log('Parameters: ' + JSON.stringify(params));
            throw new Error(resRaw.getContentText());
        }
        const res = resRaw.getContentText()
            ? JSON.parse(resRaw.getContentText())
            : {};
        if (method.toLowerCase() === 'get' || forceCache) {
            this.cache[cacheKey] = res;
        }
        return res;
    }
    objectToUrlQuery(url, obj) {
        if (!obj || (obj && Object.keys(obj).length === 0))
            return '';
        const prefix = url.includes('?') ? '&' : '?';
        return prefix.concat(Object.keys(obj)
            .map(key => {
            if (obj[key] instanceof Array) {
                const joined = obj[key].join(`&${key}=`);
                return joined.length ? `${key}=${joined}` : null;
            }
            return `${key}=${obj[key]}`;
        })
            .filter(param => param)
            .join('&'));
    }
}

class JPath {
    static getValue(path, json) {
        let tmpJson = json;
        const val = null;
        for (const part of path.split('.')) {
            if (part.startsWith('!')) {
                return this.getAgregatedValue(part.substring(1), tmpJson);
            }
            let tmpVal;
            const intVal = parseInt(part);
            if (intVal && intVal in tmpJson) {
                tmpVal = tmpJson[intVal];
            }
            else if (Object.prototype.hasOwnProperty.call(tmpJson, part)) {
                tmpVal = tmpJson[part];
            }
            else {
                break;
            }
            const typeOf = typeof tmpVal;
            if ('string' === typeOf || 'number' === typeOf) {
                return tmpVal;
            }
            else {
                tmpJson = tmpVal;
            }
        }
        return val;
    }
    static getAgregatedValue(aggFunction, json) {
        switch (aggFunction.toLowerCase()) {
            case 'min':
                return Math.min(...Object.values(json));
            case 'max':
                return Math.max(...Object.values(json));
            default:
                throw `Aggregation function "${aggFunction}" is not supported`;
        }
    }
    static setValue(obj, pathString, value) {
        let curr = obj;
        const path = pathString.split('.');
        path.forEach((key, index) => {
            if (index + 1 === path.length) {
                curr[key] = value;
            }
            else {
                if (!(key in curr)) {
                    curr[key] = {};
                }
                curr = curr[key];
            }
        });
        return obj;
    }
}

class DynamicColumnHeaders {
    constructor(headers) {
        this.headers = headers;
    }
    getMappedValues(row, namespace = undefined, includeGroup = true) {
        let res = {};
        row.forEach((cell, index) => {
            const exp = new RegExp(`^${namespace ?? '\\w+'}(?:\\.\\d)*${DynamicColumnHeaders.namespaceSeparator}`);
            if (exp.test(this.headers[index])) {
                const prefixAndPath = this.headers[index].split(DynamicColumnHeaders.namespaceSeparator);
                const namespaceAndGroupArr = prefixAndPath[0].split('.');
                const group = namespaceAndGroupArr[1] ?? '0';
                const path = `${namespace ? '' : `${namespaceAndGroupArr[0]}.`}${includeGroup ? `${group}.` : ''}${prefixAndPath[1]}`;
                res = JPath.setValue(res, path, cell);
            }
        });
        return res;
    }
    getFirstColWithNamespace(namespace) {
        const exp = new RegExp(`^${namespace ?? '\\w+'}(?:\\.\\d)*${DynamicColumnHeaders.namespaceSeparator}`);
        return this.headers.findIndex(header => exp.test(header));
    }
}
DynamicColumnHeaders.namespaceSeparator = ':';

class SheetsService {
    constructor(spreadsheetId) {
        let spreadsheet;
        if (spreadsheetId) {
            try {
                spreadsheet = SpreadsheetApp.openById(spreadsheetId);
            }
            catch (e) {
                console.error(e);
                throw new Error(`Unable to identify spreadsheet with provided ID: ${spreadsheetId}!`);
            }
        }
        else if (SpreadsheetApp.getActiveSpreadsheet() !== null) {
            spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
        }
        else if (PropertiesService.getScriptProperties()
            .getKeys()
            .includes('spreadsheetId')) {
            spreadsheet = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('spreadsheetId') ??
                '');
        }
        if (!spreadsheet) {
            throw new Error('Unable to connect to spreadsheet');
        }
        this.spreadsheet = spreadsheet;
        this.defaultMode = 'FORMULA';
    }
    setValuesInDefinedRange(sheetName, row, col, values) {
        const sheet = this.getSpreadsheet().getSheetByName(sheetName);
        if (!sheet)
            return;
        if (values[0]) {
            sheet
                .getRange(row, col, values.length, values[0].length)
                .setValues(values);
        }
    }
    getRangeData(sheetName, startRow, startCol, numRows = 0, numCols = 0) {
        const sheet = this.getSpreadsheet().getSheetByName(sheetName);
        if (!sheet || numRows + sheet.getLastRow() - startRow + 1 === 0) {
            return [[]];
        }
        return sheet
            .getRange(startRow, startCol, numRows || sheet.getLastRow() - startRow + 1, numCols || sheet.getLastColumn() - startCol + 1)
            .getValues();
    }
    getCellValue(sheetName, row, col) {
        const sheet = this.getSpreadsheet().getSheetByName(sheetName);
        return sheet ? sheet.getRange(row, col).getValue() : null;
    }
    setCellValue(row, col, val, sheetName) {
        const sheet = sheetName
            ? this.getSpreadsheet().getSheetByName(sheetName)
            : this.getSpreadsheet().getActiveSheet();
        if (!sheet)
            return;
        sheet.getRange(row, col).setValue(val);
    }
    getWaitTimeInSeconds(i) {
        return (i > 3 ? 10 : 5) * (i + 1);
    }
    getSpreadsheet() {
        return this.spreadsheet;
    }
    static getInstance(spreadsheetId) {
        if (!this.instance) {
            this.instance = new SheetsService(spreadsheetId);
        }
        return this.instance;
    }
}

class Utils {
    static getCurrentDateString() {
        return new Date()
            .toISOString()
            .replace('T', ' ')
            .replace('Z', '')
            .replace(/\.\d*/, '');
    }
}

var AUTH_MODE;
(function (AUTH_MODE) {
    AUTH_MODE["USER"] = "USER";
    AUTH_MODE["SERVICE_ACCOUNT"] = "SERVICE_ACCOUNT";
})(AUTH_MODE || (AUTH_MODE = {}));
class Auth {
    constructor(account, scope = 'https://www.googleapis.com/auth/display-video') {
        this.defaultScope = scope;
        let resolvedAccount = account;
        if (!resolvedAccount && typeof PropertiesService !== 'undefined') {
            const scriptProps = PropertiesService.getScriptProperties();
            const saProp = scriptProps.getProperty('serviceAccount') ||
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
                    this.serviceAccount = JSON.parse(resolvedAccount);
                }
                catch (e) {
                    throw new Error(`Failed to parse service account JSON: ${e.message}`);
                }
            }
            else {
                this.serviceAccount = resolvedAccount;
            }
        }
        else {
            this.authMode = AUTH_MODE.USER;
        }
    }
    getAuthToken(scope) {
        if (this.authMode === AUTH_MODE.USER) {
            return ScriptApp.getOAuthToken();
        }
        else if (!this.serviceAccount ||
            !this.serviceAccount.private_key) {
            throw new Error('No or invalid service account provided');
        }
        const tokenScope = scope ?? this.defaultScope;
        const privateKey = (this.serviceAccount.private_key || '').replace(/\\n/g, '\n');
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

class TargetAgent extends ApiHelper {
    constructor() {
        super();
        this.requiredParameters = [];
    }
    process(identifier, type, action, evaluation, params) { }
    validate(identifier, type, action, evaluation, params) {
        throw new Error('Method not implemented.');
    }
    findMissingRequiredParameter(params) {
        const keys = Object.keys(params);
        return this.requiredParameters.find(param => !keys.includes(param));
    }
    ensureRequiredParameters(params) {
        const missingParameter = this.findMissingRequiredParameter(params);
        if (missingParameter) {
            throw new Error(`Missing parameter: '${missingParameter}'`);
        }
    }
    static getInstance() {
        if (!this.instance) {
            this.instance = new this();
        }
        return this.instance;
    }
}
TargetAgent.friendlyName = '';

var DV360_ENTITY_STATUS;
(function (DV360_ENTITY_STATUS) {
    DV360_ENTITY_STATUS["ACTIVE"] = "ENTITY_STATUS_ACTIVE";
    DV360_ENTITY_STATUS["PAUSED"] = "ENTITY_STATUS_PAUSED";
})(DV360_ENTITY_STATUS || (DV360_ENTITY_STATUS = {}));
var DV360_ENTITY_TYPE;
(function (DV360_ENTITY_TYPE) {
    DV360_ENTITY_TYPE["LINE_ITEM"] = "LINE_ITEM";
    DV360_ENTITY_TYPE["INSERTION_ORDER"] = "INSERTION_ORDER";
    DV360_ENTITY_TYPE["CAMPAIGN"] = "CAMPAIGN";
})(DV360_ENTITY_TYPE || (DV360_ENTITY_TYPE = {}));
var DV360_ACTION;
(function (DV360_ACTION) {
    DV360_ACTION["TOGGLE"] = "Activate/Pause";
})(DV360_ACTION || (DV360_ACTION = {}));
class DV360 extends TargetAgent {
    constructor() {
        super();
        this.requiredParameters = ['advertiserId'];
        this.baseUrl = 'https://displayvideo.googleapis.com/v4';
    }
    process(identifier, type, action, evaluation, params) {
        this.ensureRequiredParameters(params);
        const auth = new Auth(params.serviceAccount ?? undefined);
        this.authToken = auth.getAuthToken();
        if (action === DV360_ACTION.TOGGLE) {
            return this.handleToggle(identifier, type, evaluation, params);
        }
        else {
            throw new Error(`Action '${action}' not supported in '${DV360.friendlyName}' agent`);
        }
    }
    handleToggle(identifier, type, evaluation, params) {
        if (type === DV360_ENTITY_TYPE.LINE_ITEM) {
            this.setLineItemStatus(params.advertiserId, identifier, evaluation);
        }
        else if (type === DV360_ENTITY_TYPE.INSERTION_ORDER) {
            this.setInsertionOrderStatus(params.advertiserId, identifier, evaluation);
        }
        else if (type === DV360_ENTITY_TYPE.CAMPAIGN) {
            this.setCampaignStatus(params.advertiserId, identifier, evaluation);
        }
    }
    validate(identifier, type, action, evaluation, params) {
        this.ensureRequiredParameters(params);
        const auth = new Auth(params.serviceAccount ?? undefined);
        this.authToken = auth.getAuthToken();
        let status;
        const errors = [];
        if (type === DV360_ENTITY_TYPE.LINE_ITEM) {
            status = this.isLineItemActive(params.advertiserId, identifier);
        }
        else if (type === DV360_ENTITY_TYPE.INSERTION_ORDER) {
            status = this.isInsertionOrderActive(params.advertiserId, identifier);
        }
        else if (type === DV360_ENTITY_TYPE.CAMPAIGN) {
            status = this.isCampaignActive(params.advertiserId, identifier);
        }
        if (evaluation !== status) {
            errors.push(`Status for ${identifier} (${type}) should be ${evaluation} but is ${status}`);
        }
        return errors;
    }
    fetchUrl(url, method = 'get', payload) {
        const headers = {
            Authorization: `Bearer ${this.authToken}`,
            Accept: '*/*',
        };
        return this.callApi(url, headers, undefined, payload, method);
    }
    setEntityStatus(advertiserId, entityId, status, entity) {
        const newStatus = status
            ? DV360_ENTITY_STATUS.ACTIVE
            : DV360_ENTITY_STATUS.PAUSED;
        const updateMask = {
            entityStatus: newStatus,
        };
        console.log(`Setting status of ${entityId} to ${newStatus}`);
        const url = `${this.baseUrl}/advertisers/${advertiserId}/${entity}/${entityId}?updateMask=entityStatus`;
        this.fetchUrl(url, 'patch', updateMask);
    }
    setLineItemStatus(advertiserId, lineItemId, status) {
        this.setEntityStatus(advertiserId, lineItemId, status, 'lineItems');
    }
    setInsertionOrderStatus(advertiserId, insertionOrderId, status) {
        this.setEntityStatus(advertiserId, insertionOrderId, status, 'insertionOrders');
    }
    setCampaignStatus(advertiserId, campaignId, status) {
        this.setEntityStatus(advertiserId, campaignId, status, 'campaigns');
    }
    getEntity(advertiserId, entityId, entity) {
        const url = `${this.baseUrl}/advertisers/${advertiserId}/${entity}/${entityId}`;
        return this.fetchUrl(url);
    }
    isLineItemActive(advertiserId, lineItemId) {
        const entity = this.getEntity(advertiserId, lineItemId, 'lineItems');
        return DV360_ENTITY_STATUS.ACTIVE === entity.entityStatus;
    }
    isInsertionOrderActive(advertiserId, insertionOrderId) {
        const entity = this.getEntity(advertiserId, insertionOrderId, 'insertionOrders');
        return DV360_ENTITY_STATUS.ACTIVE === entity.entityStatus;
    }
    isCampaignActive(advertiserId, campaignId) {
        const entity = this.getEntity(advertiserId, campaignId, 'campaigns');
        return DV360_ENTITY_STATUS.ACTIVE === entity.entityStatus;
    }
}
DV360.friendlyName = 'DV360';

var GOOGLE_ADS_SELECTOR_TYPE;
(function (GOOGLE_ADS_SELECTOR_TYPE) {
    GOOGLE_ADS_SELECTOR_TYPE["AD_ID"] = "AD_ID";
    GOOGLE_ADS_SELECTOR_TYPE["AD_LABEL"] = "AD_LABEL";
    GOOGLE_ADS_SELECTOR_TYPE["AD_GROUP_ID"] = "AD_GROUP_ID";
    GOOGLE_ADS_SELECTOR_TYPE["AD_GROUP_LABEL"] = "AD_GROUP_LABEL";
    GOOGLE_ADS_SELECTOR_TYPE["ASSET_GROUP_ID"] = "ASSET_GROUP_ID";
    GOOGLE_ADS_SELECTOR_TYPE["ASSET_GROUP_NAME"] = "ASSET_GROUP_NAME";
})(GOOGLE_ADS_SELECTOR_TYPE || (GOOGLE_ADS_SELECTOR_TYPE = {}));
var GOOGLE_ADS_ENTITY_STATUS;
(function (GOOGLE_ADS_ENTITY_STATUS) {
    GOOGLE_ADS_ENTITY_STATUS["ENABLED"] = "ENABLED";
    GOOGLE_ADS_ENTITY_STATUS["PAUSED"] = "PAUSED";
})(GOOGLE_ADS_ENTITY_STATUS || (GOOGLE_ADS_ENTITY_STATUS = {}));
var GOOGLE_ADS_ACTION;
(function (GOOGLE_ADS_ACTION) {
    GOOGLE_ADS_ACTION["TOGGLE"] = "Enable/Pause";
})(GOOGLE_ADS_ACTION || (GOOGLE_ADS_ACTION = {}));
class GoogleAds extends TargetAgent {
    constructor() {
        super();
        this.parameters = {};
        this.requiredParameters = [
            'customerId',
            'developerToken',
        ];
        this.baseUrl = 'https://googleads.googleapis.com/v14';
    }
    process(identifier, type, action, evaluation, params) {
        this.ensureRequiredParameters(params);
        const auth = new Auth(params.serviceAccount ?? undefined, 'https://www.googleapis.com/auth/adwords');
        this.authToken = auth.getAuthToken();
        this.parameters = params;
        if (action === GOOGLE_ADS_ACTION.TOGGLE) {
            return this.handleToggle(identifier, type, evaluation, params);
        }
        else {
            throw new Error(`Action '${action}' not supported in '${GoogleAds.friendlyName}' agent`);
        }
    }
    handleToggle(identifier, type, evaluation, params) {
        const status = evaluation
            ? GOOGLE_ADS_ENTITY_STATUS.ENABLED
            : GOOGLE_ADS_ENTITY_STATUS.PAUSED;
        if (type === GOOGLE_ADS_SELECTOR_TYPE.AD_ID) {
            console.log(`Updating status of Ad ${identifier} to '${status}'`);
            this.updateAdStatusById(params.customerId, identifier.split(';').map(id => String(id)), status);
        }
        else if (type === GOOGLE_ADS_SELECTOR_TYPE.AD_LABEL) {
            this.updateAdStatusByLabel(params.customerId, identifier, status);
        }
        else if (type === GOOGLE_ADS_SELECTOR_TYPE.AD_GROUP_ID) {
            this.updateAdGroupStatusById(params.customerId, identifier.split(';').map(id => String(id)), status);
        }
        else if (type === GOOGLE_ADS_SELECTOR_TYPE.AD_GROUP_LABEL) {
            console.log(`Updating status of AdGroup by label '${identifier}' to '${status}'`);
            this.updateAdGroupStatusByLabel(params.customerId, identifier, status);
        }
        else if (type === GOOGLE_ADS_SELECTOR_TYPE.ASSET_GROUP_ID) {
            console.log(`Updating status of AssetGroup by id '${identifier}' to '${status}'`);
            this.updateAssetGroupStatusById(params.customerId, identifier.split(';').map(id => String(id)), status);
        }
        else if (type === GOOGLE_ADS_SELECTOR_TYPE.ASSET_GROUP_NAME) {
            console.log(`Updating status of AssetGroup by name '${identifier}' to '${status}'`);
            this.updateAssetGroupStatusByName(params.customerId, identifier, status);
        }
    }
    validate(identifier, type, action, evaluation, params) {
        const auth = new Auth(params.serviceAccount ?? undefined, 'https://www.googleapis.com/auth/adwords');
        this.authToken = auth.getAuthToken();
        this.parameters = params;
        const expectedStatus = evaluation
            ? GOOGLE_ADS_ENTITY_STATUS.ENABLED
            : GOOGLE_ADS_ENTITY_STATUS.PAUSED;
        let entitiesToBeChecked = [];
        const errors = [];
        if (type === GOOGLE_ADS_SELECTOR_TYPE.AD_ID) {
            entitiesToBeChecked = entitiesToBeChecked.concat(this.getAdsById(params.customerId, identifier.split(';').map(id => String(id))));
        }
        else if (type === GOOGLE_ADS_SELECTOR_TYPE.AD_LABEL) {
            entitiesToBeChecked = entitiesToBeChecked.concat(this.getAdsByLabel(params.customerId, identifier));
        }
        else if (type === GOOGLE_ADS_SELECTOR_TYPE.AD_GROUP_ID) {
            entitiesToBeChecked = entitiesToBeChecked.concat(this.getAdGroupsById(params.customerId, identifier.split(';').map(id => String(id))));
        }
        else if (type === GOOGLE_ADS_SELECTOR_TYPE.AD_GROUP_LABEL) {
            entitiesToBeChecked = entitiesToBeChecked.concat(this.getAdGroupsByLabel(params.customerId, identifier));
        }
        else if (type === GOOGLE_ADS_SELECTOR_TYPE.ASSET_GROUP_ID) {
            entitiesToBeChecked = entitiesToBeChecked.concat(this.getAssetGroupsById(params.customerId, identifier.split(';').map(id => String(id))));
        }
        else if (type === GOOGLE_ADS_SELECTOR_TYPE.ASSET_GROUP_NAME) {
            entitiesToBeChecked = entitiesToBeChecked.concat(this.getAssetGroupsByName(params.customerId, identifier));
        }
        for (const entity of entitiesToBeChecked) {
            if (entity.status !== expectedStatus) {
                errors.push(`Status for ${identifier} (${type}) should be ${expectedStatus} but is ${entity.status}`);
            }
        }
        return errors;
    }
    updateEntityStatus(path, entity, status) {
        const payload = {
            operations: [
                {
                    updateMask: 'status',
                    update: {
                        resourceName: entity.resourceName,
                        status: status,
                    },
                },
            ],
        };
        this.fetchUrl(path, 'POST', payload);
    }
    fetchUrl(path, method = 'get', payload, forceCache = false) {
        const headers = {
            Authorization: `Bearer ${this.authToken}`,
            Accept: '*/*',
            'developer-token': this.parameters.developerToken ?? '',
        };
        if (this.parameters.loginCustomerId) {
            headers['login-customer-id'] = String(this.parameters.loginCustomerId);
        }
        const url = `${this.baseUrl}/${path}`;
        return this.callApi(url, headers, undefined, payload, method, undefined, forceCache);
    }
    updateAdStatusById(customerId, ids, status) {
        const ads = this.getAdsById(customerId, ids);
        const path = `customers/${customerId}/adGroupAds:mutate`;
        for (const ad of ads) {
            this.updateEntityStatus(path, ad, status);
        }
    }
    updateAdGroupStatusById(customerId, ids, status) {
        const adGroups = this.getAdGroupsById(customerId, ids);
        const path = `customers/${customerId}/adGroups:mutate`;
        for (const adGroup of adGroups) {
            this.updateEntityStatus(path, adGroup, status);
        }
    }
    updateAdStatusByLabel(customerId, label, status) {
        const ads = this.getAdsByLabel(customerId, label);
        const path = `customers/${customerId}/adGroupAds:mutate`;
        for (const ad of ads) {
            this.updateEntityStatus(path, ad, status);
        }
    }
    updateAdGroupStatusByLabel(customerId, label, status) {
        const adGroups = this.getAdGroupsByLabel(customerId, label);
        const path = `customers/${customerId}/adGroups:mutate`;
        for (const adGroup of adGroups) {
            this.updateEntityStatus(path, adGroup, status);
        }
    }
    updateAssetGroupStatusById(customerId, ids, status) {
        const assetGroups = this.getAssetGroupsById(customerId, ids);
        const path = `customers/${customerId}/assetGroups:mutate`;
        for (const assetGroup of assetGroups) {
            this.updateEntityStatus(path, assetGroup, status);
        }
    }
    updateAssetGroupStatusByName(customerId, name, status) {
        const assetGroups = this.getAssetGroupsByName(customerId, name);
        const path = `customers/${customerId}/assetGroups:mutate`;
        for (const assetGroup of assetGroups) {
            this.updateEntityStatus(path, assetGroup, status);
        }
    }
    getAdsById(customerId, ids) {
        const query = `
        SELECT 
          ad_group_ad.ad.id,
          ad_group_ad.status
        FROM ad_group_ad
        WHERE 
          ad_group_ad.ad.id IN (${ids.join(',')})
      `;
        const payload = {
            query,
        };
        const path = `customers/${customerId}/googleAds:search`;
        const res = this.fetchUrl(path, 'POST', payload, true);
        return res.results.map(result => {
            return {
                resourceName: result.adGroupAd.resourceName,
                status: result.adGroupAd.status,
            };
        });
    }
    getAdGroupsById(customerId, ids) {
        const query = `
          SELECT 
            ad_group.id,
            ad_group.status
          FROM ad_group
          WHERE 
            ad_group.id IN (${ids.join(',')})
        `;
        const payload = {
            query,
        };
        const path = `customers/${customerId}/googleAds:search`;
        const res = this.fetchUrl(path, 'POST', payload, true);
        return res.results.map(result => {
            return {
                resourceName: result.adGroup.resourceName,
                status: result.adGroup.status,
            };
        });
    }
    getAssetGroupsById(customerId, ids) {
        const query = `
          SELECT 
            asset_group.id,
            asset_group.status
          FROM asset_group
          WHERE 
            asset_group.id IN (${ids.join(',')})
        `;
        const payload = {
            query,
        };
        const path = `customers/${customerId}/googleAds:search`;
        const res = this.fetchUrl(path, 'POST', payload, true);
        return res.results.map(result => {
            return {
                resourceName: result.assetGroup.resourceName,
                status: result.assetGroup.status,
            };
        });
    }
    getAssetGroupsByName(customerId, name) {
        const query = `
          SELECT 
            asset_group.id,
            asset_group.status
          FROM asset_group
          WHERE 
            asset_group.name = '${name}'
        `;
        const payload = {
            query,
        };
        const path = `customers/${customerId}/googleAds:search`;
        const res = this.fetchUrl(path, 'POST', payload, true);
        return res.results.map(result => {
            return {
                resourceName: result.assetGroup.resourceName,
                status: result.assetGroup.status,
            };
        });
    }
    getAdsByLabel(customerId, label) {
        const labelResource = this.getAdLabelByName(customerId, label);
        const query = `
      SELECT 
        ad_group_ad.ad.id,
        ad_group_ad.status
      FROM ad_group_ad
      WHERE 
        ad_group_ad.labels CONTAINS ANY ('${labelResource}')
    `;
        const payload = {
            query,
        };
        const path = `customers/${customerId}/googleAds:search`;
        const res = this.fetchUrl(path, 'POST', payload, true);
        return res.results.map(result => {
            return {
                resourceName: result.adGroupAd.resourceName,
                status: result.adGroupAd.status,
            };
        });
    }
    getAdLabelByName(customerId, labelName) {
        const query = `
      SELECT 
        label.resource_name
      FROM ad_group_ad_label 
      WHERE 
        label.name = '${labelName}'
    `;
        const payload = {
            query,
        };
        const path = `customers/${customerId}/googleAds:search`;
        const res = this.fetchUrl(path, 'POST', payload, true);
        if (!(res.results && res.results.length)) {
            throw new Error(`Label ${labelName} not found`);
        }
        return res.results[0].label.resourceName;
    }
    getAdGroupsByLabel(customerId, label) {
        const labelResource = this.getAdGroupLabelByName(customerId, label);
        const query = `
      SELECT 
        ad_group.id,
        ad_group.status
      FROM ad_group 
      WHERE 
        ad_group.labels CONTAINS ANY ('${labelResource}')
    `;
        const payload = {
            query,
        };
        const path = `customers/${customerId}/googleAds:search`;
        const res = this.fetchUrl(path, 'POST', payload, true);
        return res.results.map(result => {
            return {
                resourceName: result.adGroup.resourceName,
                status: result.adGroup.status,
            };
        });
    }
    getAdGroupLabelByName(customerId, labelName) {
        const query = `
      SELECT 
        label.resource_name
      FROM ad_group_label 
      WHERE 
        label.name = '${labelName}'
    `;
        const payload = {
            query,
        };
        const path = `customers/${customerId}/googleAds:search`;
        const res = this.fetchUrl(path, 'POST', payload, true);
        if (!(res.results && res.results.length)) {
            throw new Error(`Label ${labelName} not found`);
        }
        return res.results[0].label.resourceName;
    }
}
GoogleAds.friendlyName = 'Google Ads';

const AVAILABLE_AGENTS = [DV360, GoogleAds];

var MODE;
(function (MODE) {
    MODE[MODE["FETCH"] = 0] = "FETCH";
    MODE[MODE["SYNC"] = 1] = "SYNC";
    MODE[MODE["FETCH_AND_SYNC"] = 2] = "FETCH_AND_SYNC";
})(MODE || (MODE = {}));
const targetAgents = {};
function onOpen() {
    const ui = SpreadsheetApp.getUi();
    ui.createMenu('IFTTA')
        .addItem('Setup', 'setup')
        .addItem('Fetch', 'fetch')
        .addItem('Sync', 'sync')
        .addItem('FetchAndSync', 'fetchAndSync')
        .addItem('Validate', 'validate')
        .addToUi();
}
function setup() {
    const ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
    PropertiesService.getScriptProperties().setProperty('spreadsheetId', ssId);
}
function fetch() {
    main(MODE.FETCH);
}
function sync() {
    main(MODE.SYNC);
}
function fetchAndSync() {
    main(MODE.FETCH_AND_SYNC);
}
function main(mode) {
    const rows = SheetsService.getInstance().getRangeData(CONFIG.rules.sheetName, 1, 1);
    if (rows.length === 0) {
        return;
    }
    const columnHeaders = rows.shift();
    const columnHeaderHelper = new DynamicColumnHeaders(columnHeaders);
    const apiHelper = new ApiHelper();
    rows.forEach((row, index) => {
        console.log(`Processing row ${index + 1}/${rows.length}`);
        const lastUpdate = Number(row[CONFIG.rules.cols.lastUpdate]);
        const updateInterval = Number(row[CONFIG.rules.cols.updateInterval]);
        let status = '';
        if (updateInterval > 0 &&
            Date.now() < lastUpdate + updateInterval * 3600 * 1000) {
            console.log('Update not due.');
            return;
        }
        try {
            if (mode === MODE.FETCH || mode === MODE.FETCH_AND_SYNC) {
                console.log('Fetching data from API...');
                const sourceParams = columnHeaderHelper.getMappedValues(row, CONFIG.sourceNamespace);
                for (const group in sourceParams) {
                    const source = sourceParams[group];
                    const res = apiHelper.callApi(source.url, source.headers, source.params);
                    row = updateRowWithResultData(columnHeaders, row, res, group);
                    const resultsHeaderStartCol = columnHeaderHelper.getFirstColWithNamespace(CONFIG.resultNamespace);
                    const results = row.slice(resultsHeaderStartCol);
                    SheetsService.getInstance().setValuesInDefinedRange(CONFIG.rules.sheetName, index + CONFIG.rules.startRow + 1, resultsHeaderStartCol + 1, [results]);
                    status = `Fetched (${Utils.getCurrentDateString()})`;
                }
            }
            if (mode === MODE.SYNC || mode === MODE.FETCH_AND_SYNC) {
                console.log('Synchronizing...');
                const evaluation = SheetsService.getInstance().getCellValue(CONFIG.rules.sheetName, index + 1 + CONFIG.rules.startRow, CONFIG.rules.cols.activationFormula + 1);
                if (evaluation === '')
                    return;
                const params = columnHeaderHelper.getMappedValues(row, CONFIG.targetNamespace, false);
                const targetAgent = getTargetAgent(row[CONFIG.rules.cols.targetAgent]);
                targetAgent.process(row[CONFIG.rules.cols.targetId], row[CONFIG.rules.cols.targetIdType], row[CONFIG.rules.cols.targetAction], evaluation, params);
                status = `Synchronized (${Utils.getCurrentDateString()})`;
                SheetsService.getInstance().setCellValue(index + CONFIG.rules.startRow + 1, CONFIG.rules.cols.lastUpdate + 1, String(Date.now()), CONFIG.rules.sheetName);
            }
        }
        catch (err) {
            status = `${Utils.getCurrentDateString()}: ${err}`;
        }
        finally {
            SheetsService.getInstance().setCellValue(index + CONFIG.rules.startRow + 1, CONFIG.rules.cols.status + 1, status, CONFIG.rules.sheetName);
        }
    });
}
function validate() {
    let errors = [];
    const rows = SheetsService.getInstance().getRangeData(CONFIG.rules.sheetName, 1, 1);
    const columnHeaders = rows.shift();
    const columnHeaderHelper = new DynamicColumnHeaders(columnHeaders);
    rows.forEach((row, index) => {
        console.log(`Validating row ${index + 1}/${rows.length}`);
        try {
            const evaluation = SheetsService.getInstance().getCellValue(CONFIG.rules.sheetName, index + CONFIG.rules.startRow + 1, CONFIG.rules.cols.activationFormula + 1);
            if (evaluation === '')
                return;
            const params = columnHeaderHelper.getMappedValues(row, CONFIG.targetNamespace, false);
            errors = errors.concat(getTargetAgent(row[CONFIG.rules.cols.targetAgent]).validate(row[CONFIG.rules.cols.targetId], row[CONFIG.rules.cols.targetIdType], row[CONFIG.rules.cols.targetAction], evaluation, params));
        }
        catch (err) {
            errors.push(JSON.stringify(err.message));
        }
    });
    console.log();
    console.log('### Validation Results ###');
    console.log(`Valid rows: ${rows.length - errors.length}/${rows.length}`);
    if (errors.length) {
        console.log();
        console.log('Result details:');
        errors.forEach(error => console.log(error));
    }
}
function updateRowWithResultData(headers, row, data, group) {
    row = row.map((cell, index) => {
        const exp = new RegExp(`^${CONFIG.resultNamespace}(?:\\.${group})*${DynamicColumnHeaders.namespaceSeparator}`);
        if (exp.test(headers[index])) {
            const path = headers[index].split(DynamicColumnHeaders.namespaceSeparator)[1];
            if (path.startsWith('!CUSTOM')) {
                const functionName = path.split('.')[1];
                if (GLOBALCTX && GLOBALCTX[functionName]) {
                    const columnHeaderHelper = new DynamicColumnHeaders(headers);
                    const customParams = columnHeaderHelper.getMappedValues(row, functionName, false);
                    return GLOBALCTX[functionName](data, customParams);
                }
            }
            else {
                return JPath.getValue(path, data);
            }
        }
        return cell;
    });
    return row;
}
function getTargetAgent(agentName) {
    if (agentName in targetAgents) {
        return targetAgents[agentName];
    }
    const agent = AVAILABLE_AGENTS.find(agent => agent.friendlyName === agentName);
    if (!agent) {
        throw new Error(`Unknown target agent: '${agentName}'`);
    }
    targetAgents[agentName] = agent.getInstance();
    return targetAgents[agentName];
}
