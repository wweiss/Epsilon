import {
    APIGatewayEvent,
    Context, DynamoDBStreamEvent,
    S3CreateEvent, S3Event,
    ScheduledEvent,
    SNSEvent
} from 'aws-lambda';
import {Logger} from '@bitblit/ratchet/dist/common/logger';
import {EpsilonConfig} from './global/epsilon-config';
import {WebHandler} from './api-gateway/web-handler';
import {LambdaEventDetector} from '@bitblit/ratchet/dist/aws/lambda-event-detector';
import {EpsilonDisableSwitches} from './global/epsilon-disable-switches';
import {SnsHandlerFunction} from './batch/sns-handler-function';
import {CronHandlerFunction} from './batch/cron-handler-function';
import {DynamoDbHandlerFunction} from './batch/dynamo-db-handler-function';
import {SaltMineHandler} from '@bitblit/saltmine/dist/salt-mine-handler';
import {S3CreateHandlerFunction} from './batch/s3-create-handler-function';
import {S3RemoveHandlerFunction} from './batch/s3-remove-handler-function';
import {EventUtil} from './api-gateway/event-util';


/**
 * This class functions as the adapter from a default lamda function to the handlers exposed via Epsilon
 */
export class EpsilonGlobalHandler {
    private cacheWebHandler: WebHandler;

    constructor(private config: EpsilonConfig) {
        if (!config) {
            throw new Error('Cannot create with null config');
        }
        if (!config.disabled) {
            config.disabled = {} as EpsilonDisableSwitches;
        }

    }

    private fetchSaltMineHandler(): SaltMineHandler {
        return (this.config.saltMine && !this.config.disabled.saltMine) ? this.config.saltMine : null;
    }

    private fetchWebHandler(): WebHandler {
        if (!this.cacheWebHandler) {
            if (this.config.apiGateway && !this.config.disabled.apiGateway) {
                this.cacheWebHandler = new WebHandler(this.config.apiGateway);
            }
        }
        return this.cacheWebHandler;
    }

    public async lambdaHandler(event: any, context: Context): Promise<any> {
        let rval : any = null;
        try {
            if (!this.config) {
                Logger.error('Config not found, abandoning');
                return false;
            }

            // Setup logging
            const logLevel: string = EventUtil.calcLogLevelViaEventOrEnvParam(Logger.getLevel(), event, this.config.loggerConfig);
            Logger.setLevelByName(logLevel);

            if (this.config.loggerConfig && this.config.loggerConfig.queryParamTracePrefixName &&
                event.queryStringParameters &&
                event.queryStringParameters[this.config.loggerConfig.queryParamTracePrefixName]) {
                Logger.info('Setting trace prefix to %s', event.queryStringParameters[this.config.loggerConfig.queryParamTracePrefixName]);
                Logger.setTracePrefix(event.queryStringParameters[this.config.loggerConfig.queryParamTracePrefixName]);
            }

            if (LambdaEventDetector.isValidApiGatewayEvent(event)) {
                Logger.debug('Epsilon: APIG: %j', event);
                const wh: WebHandler = this.fetchWebHandler();
                if (wh) {
                    rval = await wh.lambdaHandler(event as APIGatewayEvent, context);
                } else {
                    Logger.warn('API Gateway event, but no handler or disabled');
                }
            } else if (LambdaEventDetector.isValidSnsEvent(event)) {
                Logger.debug('Epsilon: SNS: %j', event);
                // If salt mine is here, it takes precedence
                const sm: SaltMineHandler = this.fetchSaltMineHandler();
                if (sm && sm.isSaltMineStartSnsEvent(event)) {
                    rval = await sm.processSaltMineSNSEvent(event, context);
                } else {
                    rval = await this.processSnsEvent(event as SNSEvent);
                }
            } else if (LambdaEventDetector.isValidS3Event(event)) {
                Logger.debug('Epsilon: S3: %j', event);

                rval = await this.processS3Event(event as S3CreateEvent);
            } else if (LambdaEventDetector.isValidCronEvent(event)) {
                Logger.debug('Epsilon: CRON: %j', event);

                rval = await this.processCronEvent(event as ScheduledEvent);
            } else if (LambdaEventDetector.isValidDynamoDBEvent(event)) {
                Logger.debug('Epsilon: DDB: %j', event);

                rval = await this.processDynamoDbEvent(event as DynamoDBStreamEvent);
            } else {
                Logger.warn('Unrecognized event, returning false : %j', event);
            }

            return rval;
        } catch (err) {
            Logger.error('Error slipped out to outer edge.  Logging and returning false : %s', err, err);
            return false;
        }
    };

    private async processSnsEvent(evt: SNSEvent): Promise<any> {
        let rval: any = null;
        if (this.config && this.config.sns && !this.config.disabled.sns && evt && evt.Records.length>0) {
            const finder: string = evt.Records[0].Sns.TopicArn;
            const handler: SnsHandlerFunction = this.findInMap<SnsHandlerFunction>(finder, this.config.sns.handlers);
            if (handler) {
                rval = await handler(evt);
            } else {
                Logger.info('Found no SNS handler for : %s', finder);
            }
        }
        return rval;
    }

    private async processS3Event(evt: S3Event): Promise<any> {
        let rval: any = null;
        if (this.config && this.config.s3 && !this.config.disabled.s3 && evt && evt.Records.length>0) {
            const finder: string = evt.Records[0].s3.bucket.name + '/' + evt.Records[0].s3.object.key;
            const isRemoveEvent: boolean = evt.Records[0].eventName && evt.Records[0].eventName.startsWith('ObjectRemoved');

            if (isRemoveEvent) {
                const handler: S3CreateHandlerFunction = this.findInMap<S3CreateHandlerFunction>(finder, this.config.s3.removeHandlers);
                if (handler) {
                    rval = await handler(evt);
                } else {
                    Logger.info('Found no s3 create handler for : %s', finder);
                }

            } else {
                const handler: S3RemoveHandlerFunction = this.findInMap<S3RemoveHandlerFunction>(finder, this.config.s3.createHandlers);
                if (handler) {
                    rval = await handler(evt);
                } else {
                    Logger.info('Found no s3 remove handler for : %s', finder);
                }
            }

        }
        return rval;
    }

    private async processCronEvent(evt: ScheduledEvent): Promise<any> {
        let rval: any = null;
        if (this.config && this.config.cron && !this.config.disabled.cron && evt && evt.resources[0]) {
            const finder: string = evt.resources[0];
            const handler: CronHandlerFunction = this.findInMap<CronHandlerFunction>(finder, this.config.cron.handlers);
            if (handler) {
                rval = await handler(evt);
            } else {
                Logger.info('Found no Cron handler for : %s', finder);
            }
        }
        return rval;
    }

    private async processDynamoDbEvent(evt: DynamoDBStreamEvent): Promise<any> {
        let rval: any = null;
        if (this.config && this.config.dynamoDb && !this.config.disabled.dynamoDb && evt && evt.Records && evt.Records.length > 0) {
            const finder: string = evt.Records[0].eventSourceARN;
            const handler: DynamoDbHandlerFunction = this.findInMap<DynamoDbHandlerFunction>(finder, this.config.dynamoDb.handlers);
            if (handler) {
                rval = await handler(evt);
            } else {
                Logger.info('Found no Dynamo handler for : %s', finder);
            }
        }
        return rval;
    }

    private findInMap<T>(toFind: string, map: Map<string, T>): T {
        let rval: T = null;
        map.forEach((val, key) => {
            if (this.matchExact(key, toFind)) {
                rval = val;
            }
        })
        return rval;
    }

    private matchExact(r, str) {
        var match = str.match(r);
        return match != null && str == match[0];
    }

}
