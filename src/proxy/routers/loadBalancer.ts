'use strict';

import * as Joi from 'joi';
import * as _ from 'lodash';
import * as chooser from 'weighted';
import { ValidationError } from '../../error/errors';
import { Container } from 'typescript-ioc';
import { getMilisecondsInterval } from '../../utils/time-intervals';
import { PluginsDataService } from '../../service/plugin-data';
import { HealthCheck } from '../../utils/health-check';

interface LoadBalancerConfig {
    destinations: Array<Destination>;
    database?: LoadBalancerDatabaseConfig;
    /**
     * The Load Balancer strategy used to choose one between the available service nodes. Defaults to random.
     */
    strategy?: string;
}

interface LoadBalancerDatabaseConfig {
    key?: string;
    checkInterval?: string | number;
}

interface Destination {
    target: string;
    weight?: number;
    healthCheck?: string;
    isDown?: boolean;
}

const loadBalancerConfigSchema = Joi.object().keys({
    database: Joi.object().keys({
        checkInterval: Joi.alternatives([Joi.string(), Joi.number().positive()]),
        key: Joi.string()
    }),
    destinations: Joi.array().items(Joi.object().keys({
        healthCheck: Joi.string(),
        target: Joi.string().required(),
        weight: Joi.number()
    })).min(1).required(),
    strategy: Joi.string().valid('random', 'round-robin', 'weight')
});

function validateLoadBalancerConfig(config: LoadBalancerConfig) {
    const result = Joi.validate(config, loadBalancerConfigSchema);
    if (result.error) {
        throw new ValidationError(result.error);
    } else {
        return result.value;
    }
}

abstract class Balancer {
    protected verifiedInstances: Array<Destination>;
    protected serviceInstances: Array<Destination>;
    protected fixedServiceInstances: Array<Destination>;
    protected healthChecker: HealthCheck;
    protected previousDBData: Array<string>;

    constructor(config: LoadBalancerConfig) {
        this.fixedServiceInstances = config.destinations;
        this.updateInstances(this.fixedServiceInstances);
        this.observeDatabase(config);
    }

    protected observeDatabase(config: LoadBalancerConfig) {
        if (config.database) {
            const pluginsDataService: PluginsDataService = Container.get(PluginsDataService);
            pluginsDataService.on('changed', (data: Array<string>) => {
                if (!_.isEqual(this.previousDBData, data)) {
                    this.previousDBData = data;
                    if (data && data.length) {
                        const dbConfig: Array<Destination> = data.map(item => JSON.parse(item));
                        this.updateInstances(this.mergeInstances(dbConfig));
                    } else {
                        this.updateInstances(this.mergeInstances(null));
                    }
                }
            });
            pluginsDataService.watchConfigurationItems(config.database.key || 'loadBalancer:instances',
                                        getMilisecondsInterval(config.database.checkInterval, 30000));
        }
    }

    protected mergeInstances(data: Array<Destination>) {
        if (data && data.length) {
            return _.unionWith(this.fixedServiceInstances, data, _.isEqual);
        }
        return this.fixedServiceInstances;
    }

    protected updateInstances(data: Array<Destination>) {
        this.serviceInstances = data;
        this.checkInstances(data);
    }

    protected checkInstances(data: Array<Destination>) {
        const monitoredInstances = data.filter(destination => destination.healthCheck);
        if (monitoredInstances && monitoredInstances.length) {
            if (this.healthChecker) {
                this.healthChecker.stop();
                this.healthChecker.removeAllListeners();
            }
            this.healthChecker = new HealthCheck({
                servers: monitoredInstances.map(server => server.healthCheck)
            });
            this.healthChecker.on('change', (servers: any) => {
                Object.keys(servers).forEach(server => {
                    const index = _.findIndex(this.serviceInstances, (instance) => instance.healthCheck === server);
                    if (index >= 0) {
                        this.serviceInstances[index].isDown = servers[server].down;
                    }
                });
            });
            this.verifiedInstances = this.serviceInstances.filter(server => !server.isDown);
        } else {
            this.verifiedInstances = this.serviceInstances;
        }
    }

    abstract balance(): string;
}

class RandomBalancer extends Balancer {
    constructor(config: LoadBalancerConfig) {
        super(config);
    }

    balance(): string {
        return this.verifiedInstances[Math.floor(Math.random() * this.verifiedInstances.length)].target;
    }
}

class RoundRobinBalancer extends Balancer {
    constructor(config: LoadBalancerConfig) {
        super(config);
    }
    balance(): string {
        let next = (<any>this.verifiedInstances).next || 0;
        const index = next % this.verifiedInstances.length;
        next++;
        (<any>this.verifiedInstances).next = next;
        return this.verifiedInstances[index].target;
    }
}

class WeightedBalancer extends Balancer {
    private instances: Array<string>;
    private weights: Array<number>;

    constructor(config: LoadBalancerConfig) {
        super(config);
    }

    protected updateInstances(data: Array<Destination>) {
        super.updateInstances(data);
        this.instances = this.verifiedInstances.map(item => item.target);
        this.weights = this.verifiedInstances.map(item => item.weight);
    }

    balance(): string {
        return chooser.select(this.instances, this.weights);
    }
}

module.exports = function(config: LoadBalancerConfig) {
    validateLoadBalancerConfig(config);
    let balancer: Balancer;
    switch(config.strategy) {
        case 'round-robin':
            balancer = new RoundRobinBalancer(config);
            break;
        case 'weight':
            balancer = new WeightedBalancer(config);
            break;
        default:
            balancer = new RandomBalancer(config);
    }
    return (req: any) => {
        return balancer.balance();
    };
};
