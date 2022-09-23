const { assert, expect } = require("chai")
const { getNamedAccounts, deployments, ethers, network } = require("hardhat")
const { developmentChains, networkConfig } = require("../../helper-hardhat-config")

!developmentChains.includes(network.name)
    ? describe.skip
    : describe("Lottery Unit Tests", function () {
          let deployer, lottery, vrfCoordinatorV2Mock, lotteryEntranceFee, interval
          const chainId = network.config.chainId

          beforeEach(async function () {
              deployer = (await getNamedAccounts()).deployer
              await deployments.fixture(["all"])
              lottery = await ethers.getContract("Lottery", deployer)
              vrfCoordinatorV2Mock = await ethers.getContract("VRFCoordinatorV2Mock", deployer)
              lotteryEntranceFee = await lottery.getEntranceFee()
              interval = await lottery.getInterval()
          })

          describe("constructor", function () {
              it("initializes the lottery correctly", async function () {
                  const lotteryState = await lottery.getLotteryState()
                  assert.equal(lotteryState.toString(), "0")
                  assert.equal(interval.toString(), networkConfig[chainId]["interval"])
              })
          })

          describe("enterLottery", function () {
              it("reverts when you don't pay enough entrance fee", async function () {
                  await expect(lottery.enterLottery()).to.be.revertedWith(
                      "Lottery__NotEnoughEthEntered()"
                  )
              })
              it("records players when they enter", async function () {
                  await lottery.enterLottery({ value: lotteryEntranceFee })
                  const playerFromContract = await lottery.getPlayer(0)
                  assert.equal(playerFromContract, deployer)
              })
              it("emits event when player enters", async function () {
                  await expect(lottery.enterLottery({ value: lotteryEntranceFee })).to.emit(
                      lottery,
                      "LotteryEnter"
                  )
              })
              it("it doesn't allow entrance when lottery is calculating", async function () {
                  await lottery.enterLottery({ value: lotteryEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  await lottery.performUpkeep([])
                  await expect(
                      lottery.enterLottery({ value: lotteryEntranceFee })
                  ).to.be.revertedWith("Lottery__NotOpen()")
              })
          })

          describe("checkUpkeep", function () {
              it("returns false if no players have sent ETH", async function () {
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  const { upkeepNeeded } = await lottery.callStatic.checkUpkeep([])
                  assert(!upkeepNeeded)
              })
              it("returns false if lottery isn't open", async function () {
                  await lottery.enterLottery({ value: lotteryEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  await lottery.performUpkeep([])
                  const lotteryState = await lottery.getLotteryState()
                  const { upkeepNeeded } = await lottery.callStatic.checkUpkeep([])
                  assert.equal(lotteryState.toString(), "1")
                  assert(!upkeepNeeded)
              })
              it("returns false if enough time hasn't passed", async () => {
                  await lottery.enterLottery({ value: lotteryEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() - 1])
                  await network.provider.send("evm_mine", [])
                  const { upkeepNeeded } = await lottery.callStatic.checkUpkeep([])
                  assert(!upkeepNeeded)
              })
              it("returns true if enough time has passed, has players, eth, and is open", async () => {
                  await lottery.enterLottery({ value: lotteryEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  const { upkeepNeeded } = await lottery.callStatic.checkUpkeep([])
                  assert(upkeepNeeded)
              })
          })

          describe("performUpkeep", function () {
              it("can only run if checkUpkeep is true", async function () {
                  await lottery.enterLottery({ value: lotteryEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  const tx = lottery.performUpkeep([])
                  assert(tx)
              })
              it("reverts when checkUpkeep is false", async function () {
                  await expect(lottery.performUpkeep([])).to.be.revertedWith(
                      "Lottery__UpkeepNotNeeded"
                  )
              })
              it("updates the lottery state, emits an event, calls the vrf coordinator", async function () {
                  await lottery.enterLottery({ value: lotteryEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  const transactionResponse = await lottery.performUpkeep([])
                  const transactionReceipt = await transactionResponse.wait(1)
                  const requestId = transactionReceipt.events[1].args.requestId //event[0] is by the vrfCoordinator
                  const lotteryState = await lottery.getLotteryState()
                  assert(requestId)
                  assert.equal(lotteryState.toString(), "1")
              })

              describe("fulfillRandomWords", function () {
                  beforeEach(async function () {
                      await lottery.enterLottery({ value: lotteryEntranceFee })
                      await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                      await network.provider.send("evm_mine", [])
                  })

                  it("can only be called after performUpkeep", async function () {
                      await expect(
                          vrfCoordinatorV2Mock.fulfillRandomWords(0, lottery.address)
                      ).to.be.revertedWith("nonexistent request")
                      await expect(
                          vrfCoordinatorV2Mock.fulfillRandomWords(1, lottery.address)
                      ).to.be.revertedWith("nonexistent request")
                  })
                  it("picks a winner, reset lottery, send money", async function () {
                      const additionalEntrants = 3
                      const startingAccountIndex = 1 //deployer = 0
                      const accounts = await ethers.getSigners()
                      for (
                          let i = startingAccountIndex;
                          i < startingAccountIndex + additionalEntrants;
                          i++
                      ) {
                          const accountConnectedLottery = lottery.connect(accounts[i])
                          await accountConnectedLottery.enterLottery({ value: lotteryEntranceFee })
                      }

                      const startingTimeStamp = await lottery.getLatestTimestamp()
                      //simulate having to wait for fulfillRandomWords to be called just like in a real network
                      await new Promise(async (resolve, reject) => {
                          lottery.once("WinnerPicked", async () => {
                              console.log("Found the event!")
                              try {
                                  const recentWinner = await lottery.getRecentWinner()
                                  const lotteryState = await lottery.getLotteryState()
                                  const endingTimeStamp = await lottery.getLatestTimestamp()
                                  const numPlayers = await lottery.getNumberOfPlayers()
                                  const winnerEndingBalance = await accounts[1].getBalance()
                                  assert.equal(numPlayers.toString(), "0")
                                  assert.equal(lotteryState.toString(), "0")
                                  assert(endingTimeStamp > startingTimeStamp)

                                  assert.equal(
                                      winnerEndingBalance.toString(),
                                      winnerStartingBalance.add(
                                          lotteryEntranceFee.mul(additionalEntrants + 1).toString()
                                      )
                                  )
                              } catch (e) {
                                  reject(e)
                              }
                              resolve()
                          })
                          const transactionResponse = await lottery.performUpkeep([])
                          const transactionReceipt = await transactionResponse.wait(1)
                          const winnerStartingBalance = await accounts[1].getBalance()
                          await vrfCoordinatorV2Mock.fulfillRandomWords(
                              transactionReceipt.events[1].args.requestId,
                              lottery.address
                          )
                      })
                  })
              })
          })
      })
