import { type ConnectorRegistry, createConnectorRegistry } from './connector.js';
import { createDiscordConnector } from './discord.js';

/** The channels a production board sends through: the subscription routes validate against it and delivery sends through it. */
export const productionConnectors = (): ConnectorRegistry => createConnectorRegistry([createDiscordConnector()]);
