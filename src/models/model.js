'use strict';

import { debug } from './../logger';
import { DynamoDB } from 'aws-sdk';
import Joi from 'joi';
import moment from 'moment';
import base64url from 'base64-url';
import deepAssign from 'deep-assign';
import omitEmpty from 'omit-empty';

const dynamoConfig = {
  region: process.env.AWS_REGION || 'us-east-1'
};
const db = new DynamoDB.DocumentClient(dynamoConfig);

class Model {

  static save(item) {
    debug('= Model.save', item);
    const itemParams = {
      TableName: this.tableName,
      Item: item,
      ReturnValues: 'ALL_OLD'
    };
    itemParams.Item.createdAt = moment().unix();
    return this._client('put', itemParams);
  }

  static saveAll(items) {
    debug('= Model.saveAll', items);
    const itemsParams = {RequestItems: {}};
    itemsParams.RequestItems[this.tableName] = items.map(item => {
      return {PutRequest: {Item: omitEmpty(item)}};
    });
    return this._client('batchWrite', itemsParams);
  }

  static deleteAll(keys) {
    debug('= Model.deleteAll', keys);
    const itemsParams = {RequestItems: {}};
    itemsParams.RequestItems[this.tableName] = keys.map(key => {
      return {DeleteRequest: {Key: this._buildKey(key[0], key[1])}};
    });
    return this._client('batchWrite', itemsParams);
  }

  static get(hash, range, options = {}) {
    return new Promise((resolve, reject) => {
      debug('= Model.get', hash, range);
      const params = {
        TableName: this.tableName,
        Key: this._buildKey(hash, range)
      };
      const dbOptions = this._buildOptions(options);
      Object.assign(params, dbOptions);
      this._client('get', params).then(result => {
        if (result.Item) {
          resolve(this._refineItem(result.Item, options));
        } else {
          resolve({});
        }
      })
      .catch(err => reject(err));
    });
  }

  static _buildOptions(options) {
    debug('= Model._buildOptions', JSON.stringify(options));
    const fieldsOptions = this._fieldsOptions(options);
    const pageOptions = this._buildPageOptions(options);
    const limitOptions = this._buildLimitOptions(options, pageOptions);
    const filterOptions = this._filterOptions(options);
    deepAssign(fieldsOptions, pageOptions, limitOptions, filterOptions);
    debug('= Model._buildOptions fieldsOptions', JSON.stringify(fieldsOptions));
    return fieldsOptions;
  }

  static _buildLimitOptions(options) {
    if (options.limit) {
      return {Limit: options.limit};
    }
    return {};
  }

  static _buildPageOptions(options = {}) {
    var page = options.page;
    if (page) {
      if (page.charAt(0) === '-') {
        var prevPage = page.substring(1, page.length);
        return {
          ExclusiveStartKey: this.lastEvaluatedKey(prevPage),
          ScanIndexForward: !this.scanForward
        };
      } else {
        return {
          ExclusiveStartKey: this.lastEvaluatedKey(page),
          ScanIndexForward: this.scanForward
        };
      }
    }
    return {};
  }

  static _fieldsOptions(options) {
    debug('= Model._fieldsOptions', JSON.stringify(options));
    const dbOptions = {};
    if (String(options.include_fields) === 'true' && options.fields) {
      const fields = options.fields.split(',');
      dbOptions.ProjectionExpression = fields.map(field => `#${field}`).join(',');
      const fieldsMapping = fields.reduce((acumm, attrName) => {
        acumm[`#${attrName}`] = attrName;
        return acumm;
      }, {});
      dbOptions.ExpressionAttributeNames = fieldsMapping;
    }
    return dbOptions;
  }

  static _filterOptions(options) {
    debug('= Model._filterOptions', JSON.stringify(options));
    const dbOptions = {};
    if (options.filters) {
      const attributeNamesMapping = {};
      const attributeValuesMapping = {};
      const filterExpressions = [];
      Object.keys(options.filters).forEach(key => {
        const attrName = `#${key}`;
        attributeNamesMapping[attrName] = key;
        const conditions = options.filters[key];
        Object.keys(conditions).forEach(operand => {
          const value = conditions[operand];
          const attrValue = `:${key}`;
          attributeValuesMapping[attrValue] = value;
          filterExpressions.push(this._buildFilter(attrName, attrValue, this._filterOperandsMapping[operand]));
        });
      });
      dbOptions.ExpressionAttributeNames = attributeNamesMapping;
      dbOptions.ExpressionAttributeValues = attributeValuesMapping;
      dbOptions.FilterExpression = filterExpressions.join(' AND ');
    }
    return dbOptions;
  }

  static _buildFilter(key, value, operand) {
    return [key, operand, value].join(' ');
  }

  static get _filterOperandsMapping() {
    return {
      eq: '=',
      ne: '<>',
      le: '<=',
      lt: '<',
      ge: '>=',
      gt: '>'
    };
  }

  static _refineItems(items, options) {
    debug('= Model._refineItems', JSON.stringify(options));
    if (String(options.include_fields) === 'false' && options.fields) {
      return items.map(item => this._refineItem(item, options));
    } else {
      return items;
    }
  }

  static _refineItem(item, options) {
    debug('= Model._refineItem', JSON.stringify(options));
    const refined = Object.assign({}, item);
    if (String(options.include_fields) === 'false' && options.fields) {
      const fields = options.fields.split(',');
      fields.map(field => delete refined[field]);
    }
    return refined;
  }

  static update(params, hash, range) {
    return new Promise((resolve, reject) => {
      debug('= Model.update', hash, range, JSON.stringify(params));
      const dbParams = {
        TableName: this.tableName,
        Key: this._buildKey(hash, range),
        AttributeUpdates: this._buildAttributeUpdates(params),
        ReturnValues: 'ALL_NEW'
      };
      this._client('update', dbParams).then(result => resolve(result.Attributes))
      .catch(err => reject(err));
    });
  }

  static delete(hash, range) {
    return new Promise((resolve, reject) => {
      debug('= Model.delete', hash);
      const params = {
        TableName: this.tableName,
        Key: this._buildKey(hash, range)
      };
      this._client('delete', params).then(() => resolve(true))
      .catch(err => reject(err));
    });
  }

  static allBy(key, value, options = {}) {
    return new Promise((resolve, reject) => {
      debug('= Model.allBy', key, value);
      const params = {
        TableName: this.tableName,
        KeyConditionExpression: '#hkey = :hvalue',
        ExpressionAttributeNames: {'#hkey': key},
        ExpressionAttributeValues: {':hvalue': value},
        ScanIndexForward: this.scanForward
      };
      const dbOptions = this._buildOptions(options, params);
      deepAssign(params, dbOptions);
      this._client('query', params).then((result) => {
        const response = this._buildResponse(result, params, options);
        resolve(response);
      })
      .catch(err => reject(err));
    });
  }

  static _buildResponse(result, params, options) {
    const items = result.Items;
    if (this._isPaginatingBackwards(options)) items.reverse();
    const response = {
      items: this._refineItems(items, options)
    };
    const paginationKeys = this._buildPaginationKey(result, params, items, options);
    deepAssign(response, paginationKeys);
    return response;
  }

  static _buildPaginationKey(result, params, items, options) {
    debug('= Model._buildPaginationKey', JSON.stringify(params));
    const paginationKey = {};
    if (items && items.length > 0) {
      if (this._hasNextPage(result, options)) {
        const lastItem = items[items.length - 1];
        const nextPage = this._buildNextKey(lastItem);
        Object.assign(paginationKey, nextPage);
      }
      if (!this._isFirstPage(result, params, options)) {
        const firstItem = items[0];
        const prevKey = this._buildPrevKey(firstItem);
        Object.assign(paginationKey, prevKey);
      }
    }
    return paginationKey;
  }

  static _hasNextPage(result, options) {
    return !!result.LastEvaluatedKey || this._isPaginatingBackwards(options);
  }

  static _buildNextKey(lastItem) {
    debug('= Model._buildNextKey', lastItem);
    const lastKey = this._buildItemKey(lastItem);
    return {nextPage: this.nextPage(lastKey)};
  }

  static _buildPrevKey(firstItem) {
    debug('= Model._buildPrevKey', firstItem);
    const firstItemKey = this._buildItemKey(firstItem);
    return {prevPage: this.prevPage(firstItemKey)};
  }

  static _isFirstPage(result, params, options = {}) {
    return !params.ExclusiveStartKey ||
      (!!params.ExclusiveStartKey && this._isPaginatingBackwards(options) && !result.LastEvaluatedKey);
  }

  static _isPaginatingBackwards(options) {
    return options.page && options.page.charAt(0) === '-';
  }

  static countBy(key, value) {
    return new Promise((resolve, reject) => {
      debug('= Model.allBy', key, value);
      const params = {
        TableName: this.tableName,
        KeyConditionExpression: '#hkey = :hvalue',
        ExpressionAttributeNames: {'#hkey': key},
        ExpressionAttributeValues: {':hvalue': value},
        Select: 'COUNT'
      };
      this._client('query', params).then((result) => {
        resolve(result.Count);
      })
      .catch(err => reject(err));
    });
  }

  static increment(attribute, count, hash, range) {
    debug('= Model.increment', hash, range, attribute, count);
    const params = {
      TableName: this.tableName,
      Key: this._buildKey(hash, range),
      AttributeUpdates: {}
    };
    params.AttributeUpdates[attribute] = {
      Action: 'ADD',
      Value: count
    };
    return this._client('update', params);
  }

  // TODO: It could be a good idea to make increment based on this
  static incrementAll(hash, range, attrValuesObj) {
    debug('= Model.incrementAttrs', hash, range, attrValuesObj);
    const params = {
      TableName: this.tableName,
      Key: this._buildKey(hash, range),
      AttributeUpdates: {}
    };
    for (let key in attrValuesObj) {
      params.AttributeUpdates[key] = {
        Action: 'ADD',
        Value: attrValuesObj[key]
      };
    }
    return this._client('update', params);
  }

  static prevPage(key) {
    debug('= prevPage', key);
    return `-${new Buffer(JSON.stringify(key)).toString('base64')}`;
  }

  static nextPage(key) {
    return base64url.encode(JSON.stringify(key));
  }

  static lastEvaluatedKey(nextPage) {
    return JSON.parse(base64url.decode(nextPage));
  }

  static get tableName() {
    return null;
  }

  static get hashKey() {
    return 'id';
  }

  static get rangeKey() {
    return null;
  }

  static get maxRetries() {
    return 10;
  }

  static get retryDelay() {
    return 50;
  }

  static get schema() {
    return null;
  }

  static get scanForward() {
    return false;
  }

  static isValid(object) {
    debug('= Model.isValid');
    return this._validateSchema(this.schema, object);
  }

  static _validateSchema(schema, model) {
    if (!this.schema) return true;
    const result = Joi.validate(model, schema);
    return !result.error;
  }

  static _buildKey(hash, range) {
    const key = {};
    key[this.hashKey] = hash;
    if (this.rangeKey) {
      key[this.rangeKey] = range;
    }
    return key;
  }

  static _buildItemKey(item) {
    const key = {};
    key[this.hashKey] = item[this.hashKey];
    if (this.rangeKey) {
      key[this.rangeKey] = item[this.rangeKey];
    }
    return key;
  }

  static _buildAttributeUpdates(params) {
    const attrUpdates = {};
    for (let key in params) {
      if (key !== this.hashKey && key !== this.rangeKey) {
        attrUpdates[key] = {
          Action: 'PUT',
          Value: params[key]
        };
      }
    }
    return attrUpdates;
  }

  static _client(method, params, retries = 0) {
    return new Promise((resolve, reject) => {
      debug('Model._client', JSON.stringify(params));
      this._db()[method](params, (err, data) => {
        if (err) {
          debug('= Model._client', method, 'Error', err);
          reject(err);
        } else {
          debug('= Model._client', method, 'Success');
          if (data.UnprocessedItems && Object.keys(data.UnprocessedItems).length > 0 && retries < this.maxRetries) {
            debug('= Model._client', method, 'Some unprocessed items... Retrying', JSON.stringify(data));
            const retryParams = {RequestItems: data.UnprocessedItems};
            const delay = this.retryDelay * Math.pow(2, retries);
            setTimeout(() => {
              resolve(this._client(method, retryParams, retries + 1));
            }, delay);
          } else {
            debug('= Model._client', method, 'resolving', JSON.stringify(data));
            resolve(data);
          }
        }
      });
    });
  }

  static _db() {
    return db;
  }

 }

module.exports.Model = Model;
