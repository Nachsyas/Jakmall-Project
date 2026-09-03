import {
  type CreateListingCommand,
  type CreateListingMutationResult,
  type MarketplaceMutationResult,
  type NormalizedRemoteListingState,
  type UpdatePriceCommand,
  type UpdateStockCommand,
  MarketplaceExecutionUnavailableError,
} from "./types.js";

/**
 * Normalized Marketplace Execution Gateway Interface
 * Abstract boundary decoupling durable execution coordination from external marketplace transports.
 */
export interface MarketplaceExecutionGateway {
  readonly marketplaceName: string;

  createListing(
    command: CreateListingCommand
  ): Promise<CreateListingMutationResult>;

  updatePrice(
    command: UpdatePriceCommand
  ): Promise<MarketplaceMutationResult>;

  updateStock(
    command: UpdateStockCommand
  ): Promise<MarketplaceMutationResult>;

  readListingState(
    remoteListingId: string
  ): Promise<NormalizedRemoteListingState | null>;
}

/**
 * Registry holding active marketplace execution gateways.
 */
export class MarketplaceGatewayRegistry {
  private readonly gateways = new Map<string, MarketplaceExecutionGateway>();

  registerGateway(gateway: MarketplaceExecutionGateway): void {
    this.gateways.set(gateway.marketplaceName.toLowerCase(), gateway);
  }

  getGateway(marketplaceName: string): MarketplaceExecutionGateway | undefined {
    return this.gateways.get(marketplaceName.toLowerCase());
  }

  hasGateway(marketplaceName: string): boolean {
    return this.gateways.has(marketplaceName.toLowerCase());
  }
}

/**
 * Fail-closed default marketplace gateway for unsupported or unverified live transports.
 * Performs zero network calls and unconditionally throws MarketplaceExecutionUnavailableError.
 */
export class UnavailableMarketplaceExecutionGateway implements MarketplaceExecutionGateway {
  constructor(public readonly marketplaceName: string) {}

  async createListing(_command: CreateListingCommand): Promise<CreateListingMutationResult> {
    throw new MarketplaceExecutionUnavailableError(this.marketplaceName);
  }

  async updatePrice(_command: UpdatePriceCommand): Promise<MarketplaceMutationResult> {
    throw new MarketplaceExecutionUnavailableError(this.marketplaceName);
  }

  async updateStock(_command: UpdateStockCommand): Promise<MarketplaceMutationResult> {
    throw new MarketplaceExecutionUnavailableError(this.marketplaceName);
  }

  async readListingState(_remoteListingId: string): Promise<NormalizedRemoteListingState | null> {
    throw new MarketplaceExecutionUnavailableError(this.marketplaceName);
  }
}
