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

const web3 = newWeb3WithPrivateKey(
  "11".repeat(32), // random private key
  infuraUrlMain
);
const myeth = new Eth(web3, false);

// last tx: 0x34295009f2e2b05d8121393f41ef8754034d57559ad350ca0bee0fa19212bd6b
const untilBlock = 11708702;
const blocksOf90Days = 586162;
const extReward = 1e24; // 1000,000 LRC
const stakingRecordFile = "./.staking-records.json";
const rewardRecordFile = "./.reward-records.json";
const withdrawalRecordFile = "./.withdraw-records.json";
const resFile = "./.staking-reward-res.json"
const csvResFile = "./staking_rewards.csv"

const STAKING = 0;
const CLAIM = 1;
const WITHDRAWAL = 2;

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
      type: CLAIM
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
      let blocks = untilBlock - r.blockNumber;
      if (r.type == STAKING) {
        blocks = blocks < blocksOf90Days ? blocksOf90Days : blocks;
        record.point += blocks * r.amount;
        // console.log(record.point, blocks, r.amount);
      } else if (r.type == CLAIM) {
        blocks = blocks < blocksOf90Days ? blocksOf90Days : blocks;
        record.point += blocks * r.amount;
        record.reward += r.amount;
        // console.log(record.point, blocks, r.amount);
      } else {
        record.point -= blocks * r.amount;
      }
      resMap.set(r.user, record);
    } else {
      assert(r.type == STAKING, "Staking record not found for withdrawal!");
      const record: any = {};
      let blocks = untilBlock - r.blockNumber;
      blocks = blocks < blocksOf90Days ? blocksOf90Days : blocks;
      record.point = blocks * r.amount;
      record.reward = 0;
      resMap.set(r.user, record);
    }
  }
  console.log("all participants size:", resMap.size);

  let totalPoints = 0;
  let totalReward = extReward;
  for (const r of resMap.values()) {
    totalPoints += r.point;
    totalReward += r.reward;
  }

  const filteredMap = new Map();
  for (const k of resMap.keys()) {
    const r = resMap.get(k);
    let reward = totalReward * r.point / totalPoints;
    if (reward <= r.reward) continue;
    filteredMap.set(k, r);
  }

  totalPoints = 0;
  totalReward = extReward;
  for (const r of filteredMap.values()) {
    totalPoints += r.point;
    totalReward += r.reward;
  }

  let result = [];
  for (const k of filteredMap.keys()) {
    const r = filteredMap.get(k);
    let reward = totalReward * r.point / totalPoints;
    reward = (reward - r.reward) / 1e18;
    // charge 1 LRC for transfer fee:
    reward -= 1;

    // filter dust:
    if (reward < 1) continue;

    result.push(
      {
        user: k,
        reward: reward.toFixed(3),
      }
    );
  }

  fs.writeFileSync(resFile, JSON.stringify(result, undefined, 2));
  console.log("process finished. result saved to file:", resFile);

  // write result to a CSV file
  let csvContent = "Address, Reward (LRC)\n";
  for (const item of result) {
    csvContent += item.user + ", "  + item.reward + "\n";
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
