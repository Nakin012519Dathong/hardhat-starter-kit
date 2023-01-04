const { network } = require("hardhat")
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers")
const { networkConfig, developmentChains } = require("../../helper-hardhat-config")
const { assert, expect } = require("chai")

!developmentChains.includes(network.name)
    ? describe.skip
    : describe("Random Number Direct Funding Consumer Unit Tests", async function () {
          const BigNumber = ethers.BigNumber
          const pointOneLink = BigNumber.from("100000000000000000") // 0.1
          const pointZeroZeroThreeLink = BigNumber.from("3000000000000000") // 0.003
          const oneHundredLink = BigNumber.from("100000000000000000000") // 100 LINK
          const oneHundredGwei = BigNumber.from("100000000000")

          // Configuration

          // This value is the worst-case gas overhead from the wrapper contract under the following
          // conditions, plus some wiggle room:
          //   - 10 words requested
          //   - Refund issued to consumer
          const wrapperGasOverhead = BigNumber.from(60_000)
          const coordinatorGasOverhead = BigNumber.from(52_000)
          const wrapperPremiumPercentage = 10
          const maxNumWords = 10
          const weiPerUnitLink = pointZeroZeroThreeLink
          const flatFee = pointOneLink

          const fund = async (link, linkOwner, receiver, amount) => {
              await expect(link.connect(linkOwner).transfer(receiver, amount)).to.not.be.reverted
          }

          // This should match implementation in VRFV2Wrapper::calculateGasPriceInternal
          const calculatePrice = (
              gasLimit,
              _wrapperGasOverhead = wrapperGasOverhead,
              _coordinatorGasOverhead = coordinatorGasOverhead,
              _gasPriceWei = oneHundredGwei,
              _weiPerUnitLink = weiPerUnitLink,
              _wrapperPremium = wrapperPremiumPercentage,
              _flatFee = flatFee
          ) => {
              const totalGas = BigNumber.from(0)
                  .add(gasLimit)
                  .add(_wrapperGasOverhead)
                  .add(_coordinatorGasOverhead)
              const baseFee = BigNumber.from("1000000000000000000")
                  .mul(_gasPriceWei)
                  .mul(totalGas)
                  .div(_weiPerUnitLink)
              const withPremium = baseFee.mul(BigNumber.from(100).add(_wrapperPremium)).div(100)
              return withPremium.add(_flatFee)
          }

          // We define a fixture to reuse the same setup in every test.
          // We use loadFixture to run this setup once, snapshot that state,
          // and reset Hardhat Network to that snapshot in every test.
          async function deployRandomNumberConsumerFixture() {
              const [owner, requester, consumerOwner, withdrawRecipient] = await ethers.getSigners()

              // first deploy VRFCoordinatorV2
              /**
               * @dev Read more at https://docs.chain.link/docs/chainlink-vrf/
               */

              const chainId = network.config.chainId

              const coordinatorFactory = await ethers.getContractFactory(
                  "VRFCoordinatorV2Mock",
                  owner
              )
              const coordinator = await coordinatorFactory.deploy(
                  pointOneLink,
                  1e9 // 0.000000001 LINK per gas
              )

              const linkEthFeedFactory = await ethers.getContractFactory("MockV3Aggregator", owner)
              const linkEthFeed = await linkEthFeedFactory.deploy(18, weiPerUnitLink) // 1 LINK = 0.003 ETH

              const linkFactory = await ethers.getContractFactory("LinkToken", owner)
              const link = await linkFactory.deploy()

              const wrapperFactory = await ethers.getContractFactory("VRFV2Wrapper", owner)
              const wrapper = await wrapperFactory.deploy(
                  link.address,
                  linkEthFeed.address,
                  coordinator.address
              )

              const consumerFactory = await ethers.getContractFactory(
                  "RandomNumberDirectFundingConsumerV2",
                  consumerOwner
              )
              const consumer = await consumerFactory.deploy(link.address, wrapper.address)

              // configure wrapper
              const keyHash =
                  networkConfig[chainId]["keyHash"] ||
                  "0xd89b2bf150e3b9e13446986e571fb9cab24b13cea0a43ea20a6049a85cc807cc"
              await wrapper
                  .connect(owner)
                  .setConfig(
                      wrapperGasOverhead,
                      coordinatorGasOverhead,
                      wrapperPremiumPercentage,
                      keyHash,
                      maxNumWords
                  )

              // fund subscription. The Wrapper's subscription id is 1
              await coordinator.connect(owner).fundSubscription(1, oneHundredLink)

              return {
                  coordinator,
                  wrapper,
                  consumer,
                  link,
                  owner,
                  requester,
                  consumerOwner,
                  withdrawRecipient,
              }
          }

          describe("#requestRandomWords", async function () {
              describe("success", async function () {
                  it("Should successfully request a random number", async function () {
                      const { consumer, wrapper, coordinator, link, owner, consumerOwner } =
                          await loadFixture(deployRandomNumberConsumerFixture)
                      await fund(link, owner, consumer.address, oneHundredLink)
                      const gasLimit = 100_000
                      const price = calculatePrice(gasLimit)

                      const requestId = 1
                      const numWords = 1

                      await expect(
                          consumer
                              .connect(consumerOwner)
                              .requestRandomWords(gasLimit, 3, numWords, {
                                  gasPrice: oneHundredGwei,
                              })
                      )
                          .to.emit(coordinator, "RandomWordsRequested")
                          .to.emit(consumer, "RequestSent")
                          .withArgs(requestId, numWords, price)

                      expect(await link.balanceOf(wrapper.address)).to.equal(price)
                      const { paid, fulfilled } = await consumer.s_requests(requestId)
                      expect(paid).to.equal(price)
                      expect(fulfilled).to.be.false
                  })
                  /*
                  it("Should successfully request a random number and get a result", async function () {
                      const { randomNumberConsumerV2, VRFCoordinatorV2Mock } = await loadFixture(
                          deployRandomNumberConsumerFixture
                      )
                      await randomNumberConsumerV2.requestRandomWords()
                      const requestId = await randomNumberConsumerV2.s_requestId()

                      // simulate callback from the oracle network
                      await expect(
                          VRFCoordinatorV2Mock.fulfillRandomWords(
                              requestId,
                              randomNumberConsumerV2.address
                          )
                      ).to.emit(randomNumberConsumerV2, "ReturnedRandomness")

                      const firstRandomNumber = await randomNumberConsumerV2.s_randomWords(0)
                      const secondRandomNumber = await randomNumberConsumerV2.s_randomWords(1)

                      assert(
                          firstRandomNumber.gt(ethers.constants.Zero),
                          "First random number is greater than zero"
                      )

                      assert(
                          secondRandomNumber.gt(ethers.constants.Zero),
                          "Second random number is greater than zero"
                      )
                  })

                  it("Should successfully fire event on callback", async function () {
                      const { randomNumberConsumerV2, VRFCoordinatorV2Mock } = await loadFixture(
                          deployRandomNumberConsumerFixture
                      )

                      await new Promise(async (resolve, reject) => {
                          randomNumberConsumerV2.once("ReturnedRandomness", async () => {
                              console.log("ReturnedRandomness event fired!")
                              const firstRandomNumber = await randomNumberConsumerV2.s_randomWords(
                                  0
                              )
                              const secondRandomNumber = await randomNumberConsumerV2.s_randomWords(
                                  1
                              )
                              // assert throws an error if it fails, so we need to wrap
                              // it in a try/catch so that the promise returns event
                              // if it fails.
                              try {
                                  assert(firstRandomNumber.gt(ethers.constants.Zero))
                                  assert(secondRandomNumber.gt(ethers.constants.Zero))
                                  resolve()
                              } catch (e) {
                                  reject(e)
                              }
                          })
                          await randomNumberConsumerV2.requestRandomWords()
                          const requestId = await randomNumberConsumerV2.s_requestId()
                          VRFCoordinatorV2Mock.fulfillRandomWords(
                              requestId,
                              randomNumberConsumerV2.address
                          )
                      })
                  })
                  */
              })
          })
      })
