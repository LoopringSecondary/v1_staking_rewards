const fs = require("fs");
import {
  infuraUrlMain,
  newWeb3WithPrivateKey,
  Eth,
  TxOpts,
  execAsync,
  zeroAddress
} from "@freemanz/ts-utils"
const assert = require("assert");
import BigNumber from "bignumber.js";

const web3 = newWeb3WithPrivateKey(
  "11".repeat(32), // random private key
  infuraUrlMain
);
const myeth = new Eth(web3, false);

// last tx: 0x34295009f2e2b05d8121393f41ef8754034d57559ad350ca0bee0fa19212bd6b
const untilBlock = 11708702;
const blocksOf90Days = 586162;
const totalReward = new BigNumber("1" + "0".repeat(24)); // 1000,000 LRC
const stakingRecordFile = "./.staking-records.json";
const rewardRecordFile = "./.reward-records.json";
const withdrawalRecordFile = "./.withdraw-records.json";
const resFile = "./.staking-reward-res.json"
const csvResFile = "./staking_rewards.csv"

const STAKING = 0;
const WITHDRAWAL = 1;

async function fetchData() {
  console.log("fetch all LRCStaked events ...");
  const stakingEvents = await myeth.getEvents(
    "./UserStakingPool.abi",
    "0xF4662bB1C4831fD411a95b8050B3A5998d8A4A5b",
    "LRCStaked",
    10000000000,
  );

  const stakingRecords = stakingEvents.map(e => {
    return {
      blockNumber: e.blockNumber,
      user: e.returnValues.user,
      amount: Number(e.returnValues.amount),
      type: STAKING
    };
  });
  fs.writeFileSync(stakingRecordFile, JSON.stringify(stakingRecords, undefined, 2));

  console.log("fetch all LRCRewarded events ...");
  const rewardedEvents = await myeth.getEvents(
    "./UserStakingPool.abi",
    "0xF4662bB1C4831fD411a95b8050B3A5998d8A4A5b",
    "LRCRewarded",
    10000000000,
  );

  const rewardedRecords = rewardedEvents.map(e => {
    return {
      blockNumber: e.blockNumber,
      user: e.returnValues.user,
      amount: Number(e.returnValues.amount),
      type: STAKING
    };
  });
  fs.writeFileSync(rewardRecordFile, JSON.stringify(rewardedRecords, undefined, 2));

  console.log("fetch all LRCWithdrawn events ...");
  const withdrawEvents = await myeth.getEvents(
    "./UserStakingPool.abi",
    "0xF4662bB1C4831fD411a95b8050B3A5998d8A4A5b",
    "LRCWithdrawn",
    10000000000,
  );
  const withdrawRecords = withdrawEvents.map(e => {
    return {
      blockNumber: e.blockNumber,
      user: e.returnValues.user,
      amount: Number(e.returnValues.amount),
      type: WITHDRAWAL
    };
  });
  fs.writeFileSync(withdrawalRecordFile, JSON.stringify(withdrawRecords, undefined, 2));
}

function loadData() {
  const stakingRecords = JSON.parse(fs.readFileSync(stakingRecordFile, "ascii"));
  const rewardedRecords = JSON.parse(fs.readFileSync(rewardRecordFile, "ascii"));
  const withdrawRecords = JSON.parse(fs.readFileSync(withdrawalRecordFile, "ascii"));
  return {stakingRecords, rewardedRecords, withdrawRecords};
}

function stats() {
  const {stakingRecords, rewardedRecords, withdrawRecords} = loadData();
  let allRecords = stakingRecords.concat(rewardedRecords).concat(withdrawRecords);
  allRecords = allRecords.sort((r1, r2) => {
    if (r1.blockNumber == r2.blockNumber) {
      return r1.type - r2.type;  // withdrawal after reward record.
    } else {
      return r1.blockNumber - r2.blockNumber;
    }
  });
  // console.log("allRecords:", allRecords.slice(100));

  const resMap = new Map();
  for(const r of allRecords) {
    if (r.blockNumber > untilBlock) continue;
    if (resMap.has(r.user)) {
      const record = resMap.get(r.user);
      if (r.type == STAKING) {

        const newBlockNumber = Math.round(
          (record.blockNumber * record.amount + r.blockNumber * r.amount) /
            (record.amount + r.amount)
        );
        record.blockNumber = newBlockNumber;
        record.amount = record.amount + r.amount;

      } else {
        record.blockNumber = r.blockNumber;
        record.amount = record.amount - r.amount;
      }
      resMap.set(r.user, record);
    } else {
      assert(r.type == STAKING, "Staking record not found for withdrawal!");
      resMap.set(r.user, r);
    }
  }
  console.log("all participants size:", resMap.size);

  // filter dust.
  const qualifiedRecords = [...resMap.values()].filter(r => Math.abs(r.amount) > 1e18);
  console.log("qualifiedRecords length:", qualifiedRecords.length);

  let totalPoints = new BigNumber(0);
  for (const r of qualifiedRecords) {
    assert(r.amount > 0, "amount < 0 after filter.");
    let blocks = untilBlock - r.blockNumber;
    blocks = blocks < blocksOf90Days ? blocksOf90Days : blocks;
    const point = new BigNumber(r.amount).times(blocks);
    totalPoints = totalPoints.plus(point);
  }

  let result = [];
  for (const r of qualifiedRecords) {
    let blocks = untilBlock - r.blockNumber;
    blocks = blocks < blocksOf90Days ? blocksOf90Days : blocks;
    const point = new BigNumber(r.amount).times(blocks);
    let rewardBN = totalReward.times(point).div(totalPoints);

    // skip if reward <= 1 LRC
    if (rewardBN.lte(1e18)) continue;

    // charge 1 LRC for transfer fee:
    rewardBN = rewardBN.minus(1e18);

    r.reward = rewardBN.toFixed(0, 1);
    r.rewardFixed = rewardBN.div(1e18).toFixed(2, 1);
    result.push(
      {
        user: r.user,
        reward: r.reward,
        rewardFixed: r.rewardFixed
      }
    );
  }

  fs.writeFileSync(resFile, JSON.stringify(result, undefined, 2));
  console.log("process finished. result saved to file:", resFile);

  // write result to a CSV file
  let csvContent = "Address, Reward (LRC)\n";
  for (const item of result) {
    // filter zero
    if (Number(item.rewardFixed) == 0)  continue;
    csvContent += item.user + ", "  + item.rewardFixed + "\n";
  }

  fs.writeFileSync(csvResFile, csvContent);
}

function checkResSum() {
  const resArr =JSON.parse(fs.readFileSync(resFile, "ascii"));
  let sum = 0;
  for (const item of resArr) {
    sum += Number(item.reward);
  }
  console.log("total reward sum:", sum);
}

async function main() {
  await fetchData();
  stats();
  checkResSum();
}

main()
  .then(() => process.exit(0))
  .catch(err => {console.error(err); process.exit(1)});
