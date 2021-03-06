const cheerio = require('cheerio')
const util = require('util')

const helpers = require('../helpers')
const logging = require('../logging')

class Parser {
  constructor (parent) {
    this.parent = parent
    this.config = parent.config
  }

  _parse (results) {
    const { query, json, html } = results
    let ret

    // Store query
    this.query = query

    // Parse any HTML assets
    if (html) {
      html.forEach(x => { x.$ = cheerio.load(x.contents) })
    }

    // Call implementation-specific parser
    ret = this.parse(query, { json, html })
    if (ret && ret.error) {
      return ret
    }

    // Normalize and validate awards
    ret = this.normalizeAwards(query, ret.awards)
    if (ret && ret.error) {
      return ret
    }

    // Combine awards for the same flight
    ret.awards = this.simplifyAwards(ret.awards)

    return ret
  }

  normalizeAwards (query, awards) {
    // Fill in awards with common info
    for (const award of awards) {
      const error = this.normalizeAward(query, award)
      if (error) {
        return { awards, error }
      }
    }
    return { awards }
  }

  normalizeAward (query, award) {
    const {
      engine,
      partner,
      fromCity,
      toCity,
      date,
      duration,
      travelTime,
      cabin,
      mixed,
      stops,
      quantity,
      fares,
      segments
    } = award

    // Check that segments is not empty
    if (!segments || !segments.length) {
      return `Missing segments for award: ${award}`
    }
    const first = segments[0]
    const last = segments[segments.length - 1]

    // Check each segment first
    for (const segment of segments) {
      // Check required information
      const {
        airline,
        flight,
        fromCity,
        toCity,
        date,
        departure,
        arrival,
        duration,
        nextConnection,
        stops,
        lagDays
      } = segment

      // Check required information
      if (!this.validAirlineCode(airline)) {
        return `Award has invalid airline code in segment: ${util.inspect(segment)}`
      }
      if (flight === undefined) {
        return `Award is missing property 'flight' in segment: ${util.inspect(segment)}`
      }
      if (!this.validAirportCode(fromCity)) {
        return `Award has invalid origin airport code in segment: ${util.inspect(segment)}`
      }
      if (!this.validAirportCode(toCity)) {
        return `Award has invalid destination airport code in segment: ${util.inspect(segment)}`
      }
      if (date === undefined || !this.validDate(date)) {
        return `Award has invalid departure date in segment: ${util.inspect(segment)}`
      }
      if (departure === undefined || !this.validTime(departure)) {
        return `Award has invalid departure in segment: ${util.inspect(segment)}`
      }
      if (arrival === undefined || !this.validTime(arrival)) {
        return `Award has invalid arrival in segment: ${util.inspect(segment)}`
      }
      if (lagDays === undefined || !Number.isInteger(lagDays)) {
        return `Award has invalid lag days in segment: ${util.inspect(segment)}`
      }

      // Fill in defaults
      segment.duration = duration || this.duration(segment)
      segment.nextConnection = nextConnection || this.nextConnection(segment, segments)
      segment.stops = stops || 0
    }

    // Check required information
    if (fares === undefined) {
      return `Award is missing property 'fares': ${award}`
    }

    // Fill in defaults
    award.engine = engine || query.engine
    award.partner = partner || this.partnerAward(query.engine, segments)
    award.fromCity = fromCity || first.fromCity
    award.toCity = toCity || last.toCity
    award.date = date || first.date
    award.cabin = cabin || this.bestCabin(segments)
    award.mixed = mixed || this.mixedCabin(segments)
    award.duration = duration || this.duration(first, last)
    award.travelTime = travelTime || this.travelTime(segments)
    award.stops = stops || this.totalStops(segments)
    award.quantity = quantity || query.quantity
  }

  simplifyAwards (awards) {
    // Group awards by list of identifying attributes
    const map = new Map()
    awards.forEach(award => {
      const { segments, cabin, mixed, quantity, mileage } = award
      const key = [...segments.map(x => x.flight), cabin, mixed, quantity, mileage].join('|')
      let arr = map.get(key)
      if (!arr) {
        arr = []
        map.set(key, arr)
      }
      arr.push(award)
    })

    // Combine fare codes for all awards with the same key
    return [...map.values()].map(arr => {
      const fares = []
      const set = new Set()
      for (const award of arr) {
        for (const code of award.fares.split(' ')) {
          if (code !== '' && !set.has(code)) {
            set.add(code)
            fares.push(code)
          }
        }
      }
      arr[0].fares = fares.join(' ')
      return arr[0]
    })
  }
}

module.exports = helpers(logging(Parser))
