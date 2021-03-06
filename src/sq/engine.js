const Engine = require('../base/engine')
const { cabins } = require('../consts')

module.exports = class extends Engine {
  async isLoggedIn (page) {
    try {
      await page.waitFor(
        '#kfLoginPopup #membership-1, a.login, li.logged-in', {visible: true, timeout: 10000})
    } catch (err) {}
    return !!(await page.$('li.logged-in'))
  }

  async login (page, credentials) {
    const [ username, password ] = credentials
    if (!username || !password) {
      return { error: `Missing login credentials` }
    }

    // Dismiss popups
    await this.prepare()

    // Check if the login form is visible
    let formVisible = true
    try {
      await page.waitFor('#kfLoginPopup #membership-1', {visible: true, timeout: 1000})
    } catch (err) {
      formVisible = false
    }

    if (!formVisible) {
      // Click the login link
      const login = await page.waitFor('a.login', {visible: true})
      await login.asElement().click()
      await page.waitFor('#kfLoginPopup #membership-1', {visible: true})
      await page.waitFor(1000)
    }

    // Enter username and password
    await page.click('#kfLoginPopup #membership-1')
    await page.waitFor(1000)
    await page.keyboard.type(username, { delay: 10 })
    await page.click('#kfLoginPopup #membership-2')
    await page.waitFor(1000)
    await page.keyboard.type(password, { delay: 10 })
    await page.waitFor(250)

    // Check remember box, and submit the form
    if (!await page.$('#kfLoginPopup #checkbox-1:checked')) {
      await page.click('#kfLoginPopup #checkbox-1')
      await page.waitFor(250)
    }
    await this.clickAndWait('#kfLoginPopup #submit-1')
    await this.settle()

    // Bypass invisible captcha, if present
    const bypassed = await page.evaluate(() => {
      if (typeof captchaSubmit === 'function') {
        captchaSubmit()
        return true
      }
      return false
    })
    if (bypassed) {
      this.info('Detected and bypassed invisible captcha')
      await page.waitFor(3000)
      await this.settle()
      await page.waitFor(5000)
    }
  }

  validate (query) {}

  async search (page, query) {
    const { partners, fromCity, toCity, oneWay, departDate, returnDate, cabin, quantity } = query

    // Make sure page is ready
    await this.prepare()

    // Check the Redeem Flights radio button
    await page.waitFor('#travel-radio-2', { visible: true })
    await page.click('#travel-radio-2')
    await this.settle()

    // Check the Return or One-way radio button
    if (oneWay) {
      await page.waitFor('#city1-radio-5', {visible: true})
      await page.click('#city1-radio-5')
    } else {
      await page.waitFor('#city1-radio-4', {visible: true})
      await page.click('#city1-radio-4')
    }
    await this.settle()

    // Fill form values
    const cabinCode = {
      [cabins.first]: 'F',
      [cabins.business]: 'J',
      [cabins.premium]: 'S',
      [cabins.economy]: 'Y'
    }
    await this.fillForm({
      'orbOrigin': fromCity,
      'orbDestination': toCity,
      'departureMonth': departDate.toFormat('dd/MM/yyyy'),
      'returnMonth': returnDate ? returnDate.toFormat('dd/MM/yyyy') : '',
      'cabinClass': cabinCode[cabin],
      'numOfAdults': quantity.toString(),
      'numOfChildren': '0',
      'numOfChildNominees': 0,
      'numOfAdultNominees': 0
    })

    // There are extraneous inputs that need to be removed from form submission
    await page.evaluate(() => {
      document.querySelector('#form-book-travel-1 [name="destinationDropDown"]').name = ''
      document.querySelector('#city1-travel-start-day-2').name = ''
    })

    // Submit the form
    let ret = await this.submitForm('form-book-travel-1')
    if (ret && ret.error) {
      return ret
    }
    await this.settle()

    // Save the results
    ret = await this.saveHTML('results')
    if (ret && ret.error) {
      return ret
    }

    // If partners requested, check those as well
    if (partners) {
      // Show "Star Alliance" flights
      ret = await this.save('.orb-selectflight-btn-group > a:nth-child(3)', 'partners1')
      if (ret && ret.error) {
        return ret
      }

      // Show "Other Partner" flights
      ret = await this.save('.orb-selectflight-btn-group > a:nth-child(4)', 'partners2')
      if (ret && ret.error) {
        return ret
      }
    }
  }

  async save (sel, id) {
    const response = await this.clickAndWait(sel)
    await this.settle()

    // Check response code
    let ret = this.validResponse(response)
    if (ret && ret.error) {
      return ret
    }

    // Save the results
    ret = await this.saveHTML(id)
    if (ret && ret.error) {
      return ret
    }
  }

  async prepare () {
    const { page } = this

    // Ensure page is loaded, since we're only waiting until 'domcontentloaded' event
    await page.waitFor(1000)
    await this.settle()

    // Dismiss modal pop-up's
    while (true) {
      if (
        await this.clickIfVisible('div.cookie-continue') ||
        await this.clickIfVisible('div.insider-opt-in-disallow-button') ||
        await this.clickIfVisible('div.ins-survey-435-close')
      ) {
        await page.waitFor(2000)
        continue
      }
      break
    }
  }

  async settle () {
    // Wait for spinner
    await this.monitor('div.overlay-loading')

    // Check for survey pop-up
    await this.clickIfVisible('div[class^="ins-survey-"][class$="-close"]')
  }
}
