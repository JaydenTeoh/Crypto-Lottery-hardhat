const { assert, expect } = require("chai")
const { getNamedAccounts, deployments, ethers, network } = require("hardhat")
const { isCallTrace } = require("hardhat/internal/hardhat-network/stack-traces/message-trace")
const { developmentChains, networkConfig } = require("../../helper-hardhat-config")

developmentChains.includes(network.name)
    ? describe.skip
    : describe("Lottery Unit Tests", function () {
          let deployer, lottery, lotteryEntranceFee

          beforeEach(async function () {
              deployer = (await getNamedAccounts()).deployer
              lottery = await ethers.getContract("Lottery", deployer)
              lotteryEntranceFee = await lottery.getEntranceFee()
          })

          describe("fulfillRandomWords", function () {
              it("works with live Chainlink Keepers and CHainlink VRF, we get a random winner", async function () {
                  const startingTimestamp = await lottery.getLatestTimestamp()
                  const accounts = await ethers.getSigners()
                  await new Promise(async (resolve, reject) => {
                      lottery.once("WinnerPicked", async function () {
                          console.log("WinnerPicked event fired!")
                          try {
                              const recentWinnner = await lottery.getRecentWinner()
                              const lotteryState = await lottery.getLotteryState()
                              const winnerEndingBalance = await accounts[0].getBalance()
                              const endingTimeStamp = await lottery.getLatestTimestamp()

                              await expect(lottery.getPlayer(0)).to.be.reverted
                              assert.equal(recentWinnner.toString(), accounts[0].address)
                              assert.equal(lotteryState.toString(), "0")
                              assert.equal(
                                  winnerEndingBalance.toString(),
                                  winnerStartingBalance.add(lotteryEntranceFee).toString()
                              )
                              assert(endingTimeStamp > startingTimestamp)
                              resolve()
                          } catch (e) {
                              console.log(e)
                              reject(e)
                          }
                      })

                      console.log("Entering Lottery...")
                      const tx = await lottery.enterLottery({ value: lotteryEntranceFee })
                      const winnerStartingBalance = await accounts[0].getBalance()
                      await tx.wait(1)
                      console.log("Ok, time to wait...")
                  })
              })
          })
      })
