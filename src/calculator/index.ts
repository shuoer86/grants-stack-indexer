/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import csv from "csv-parser";
import { linearQF, Contribution, Calculation } from "pluralistic";
import { convertToUSD } from "../prices/index.js";
import { tokenDecimals } from "../config.js";

export class FileNotFoundError extends Error {
  constructor(fileDescription: string) {
    super(`cannot find ${fileDescription} file`);
  }
}

export class ResourceNotFoundError extends Error {
  constructor(resource: string) {
    super(`${resource} not found`);
  }
}

export class OverridesColumnNotFoundError extends Error {
  constructor(column: string) {
    super(`cannot find column ${column} in the overrides file`);
  }
}

export interface DataProvider {
  loadFile(description: string, path: string): Array<any>;
}

export type Overrides = {
  [contributionId: string]: string;
};

export class FileSystemDataProvider {
  basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  loadFile(description: string, path: string) {
    const fullPath = `${this.basePath}/${path}`;
    if (!fs.existsSync(fullPath)) {
      throw new FileNotFoundError(description);
    }

    const data = fs.readFileSync(fullPath, {
      encoding: "utf8",
      flag: "r",
    });

    return JSON.parse(data);
  }
}

export function parseOverrides(buf: Buffer): Promise<any> {
  return new Promise((resolve, _reject) => {
    const results: Overrides = {};
    const stream = csv()
      .on("headers", (headers) => {
        if (headers.indexOf("contributionId") < 0) {
          throw new OverridesColumnNotFoundError("contributionId");
        }

        if (headers.indexOf("coefficient") < 0) {
          throw new OverridesColumnNotFoundError("coefficient");
        }
      })
      .on("data", (data) => {
        results[data["contributionId"]] = data["coefficient"];
      })
      .on("end", () => {
        resolve(results);
      });

    stream.write(buf);
    stream.end();
  });
}

export type CalculatorOptions = {
  dataProvider: DataProvider;
  chainId: number;
  roundId: string;
  minimumAmount?: bigint;
  matchingCapAmount?: bigint;
  passportThreshold?: number;
  enablePassport?: boolean;
  ignoreSaturation?: boolean;
  overrides: Overrides;
};

export type AugmentedResult = Calculation & {
  projectId: string;
  applicationId: string;
  matchedUSD: number;
  projectName: string;
  payoutAddress: string;
};

type RawContribution = {
  id: string;
  voter: string;
  projectId: string;
  applicationId: string;
  amountUSD: number;
  amountRoundToken: string;
};

type RawRound = {
  token: string;
  id: string;
  matchAmount: string;
  matchAmountUSD: number;
  metadata?: {
    quadraticFundingConfig?: {
      matchingFundsAvailable?: number;
      sybilDefense?: boolean;
      matchingCap?: boolean;
      matchingCapAmount?: number;
      minDonationThreshold?: boolean;
      minDonationThresholdAmount?: number;
    };
  };
};

export default class Calculator {
  private dataProvider: DataProvider;
  private chainId: number;
  private roundId: string;
  private minimumAmount: bigint | undefined;
  private matchingCapAmount: bigint | undefined;
  private enablePassport: boolean | undefined;
  private passportThreshold: number | undefined;
  private ignoreSaturation: boolean | undefined;
  private overrides: Overrides;

  constructor(options: CalculatorOptions) {
    this.dataProvider = options.dataProvider;
    this.chainId = options.chainId;
    this.roundId = options.roundId;
    this.minimumAmount = options.minimumAmount;
    this.enablePassport = options.enablePassport;
    this.passportThreshold = options.passportThreshold;
    this.matchingCapAmount = options.matchingCapAmount;
    this.overrides = options.overrides;
    this.ignoreSaturation = options.ignoreSaturation;
  }

  async calculate(): Promise<Array<AugmentedResult>> {
    const rawContributions: Array<RawContribution> = this.parseJSONFile(
      "votes",
      `${this.chainId}/rounds/${this.roundId}/votes.json`
    );
    const applications = this.parseJSONFile(
      "applications",
      `${this.chainId}/rounds/${this.roundId}/applications.json`
    );
    const rounds: RawRound[] = this.parseJSONFile(
      "rounds",
      `${this.chainId}/rounds.json`
    );
    const passportScores = this.parseJSONFile(
      "passport scores",
      "passport_scores.json"
    );

    const round = rounds.find((r: RawRound) => r.id === this.roundId);
    if (round === undefined) {
      throw new ResourceNotFoundError("round");
    }

    if (round.matchAmount === undefined) {
      throw new ResourceNotFoundError("round match amount");
    }

    if (round.token === undefined) {
      throw new ResourceNotFoundError("round token");
    }

    const matchAmount = BigInt(round.matchAmount);
    const matchTokenDecimals = BigInt(tokenDecimals[this.chainId][round.token]);

    const enablePassport =
      this.enablePassport ??
      round.metadata?.quadraticFundingConfig?.sybilDefense ??
      false;

    // 1. convert threshold amount to 6 decimals
    // 2. truncate rest of decimals to bigint
    // 3. convert decimals to token decimals
    // 4. remove initial 6 decimals
    const minimumAmount =
      this.minimumAmount ??
      (BigInt(
        Math.trunc(
          Number(
            round.metadata?.quadraticFundingConfig
              ?.minDonationThresholdAmount ?? 0
          ) * Math.pow(10, 6)
        )
      ) *
        10n ** matchTokenDecimals) /
        10n ** 6n ??
      0n;

    let matchingCapAmount = this.matchingCapAmount;

    if (
      matchingCapAmount === undefined &&
      (round.metadata?.quadraticFundingConfig?.matchingCap ?? false)
    ) {
      // round.metadata.quadraticFundingConfig.matchingCapAmount is a percentage, 0 to 100, could contain decimals
      matchingCapAmount =
        (matchAmount *
          BigInt(
            Math.trunc(
              Number(
                round.metadata?.quadraticFundingConfig?.matchingCapAmount ?? 0
              ) * 100
            )
          )) /
        10000n;
    }

    const isEligible = (addressData: any): boolean => {
      const hasValidEvidence = addressData?.evidence?.success;

      if (enablePassport) {
        if (typeof this.passportThreshold !== "undefined") {
          return (
            parseFloat(addressData?.evidence.rawScore ?? "0") >
            this.passportThreshold
          );
        } else {
          return hasValidEvidence;
        }
      }
      return true;
    };

    const passportIndex = passportScores.reduce((ps: any, acc: any) => {
      acc[ps.address] = ps;
      return acc;
    }, {});

    const contributions: Array<Contribution> = [];

    for (let i = 0; i < rawContributions.length; i++) {
      const raw = rawContributions[i];
      const addressData = passportIndex[raw.voter];
      const override = this.overrides[raw.id];

      if (override !== undefined && override !== "1") {
        continue;
      }

      if (!isEligible(addressData)) {
        continue;
      }

      contributions.push({
        contributor: raw.voter,
        recipient: raw.applicationId,
        amount: BigInt(raw.amountRoundToken),
      });
    }

    const results = linearQF(contributions, matchAmount, matchTokenDecimals, {
      minimumAmount,
      matchingCapAmount,
      ignoreSaturation: this.ignoreSaturation ?? false,
    });

    const augmented: Array<AugmentedResult> = [];

    for (const id in results) {
      const calc = results[id];
      const application = applications.find((a: any) => a.id === id);

      const conversionUSD = await convertToUSD(
        this.chainId,
        round.token,
        calc.matched
      );

      augmented.push({
        ...calc,
        matchedUSD: conversionUSD.amount,
        projectId: application.projectId,
        applicationId: application.id,
        projectName: application.metadata?.application?.project?.title,
        payoutAddress: application.metadata?.application?.recipient,
      });
    }

    return augmented;
  }

  parseJSONFile(fileDescription: string, path: string) {
    return this.dataProvider.loadFile(fileDescription, path);
  }
}