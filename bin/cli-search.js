const program = require('commander')
const fs = require('fs')
const humanize = require('humanize-duration')
const { DateTime } = require('luxon')
const prompt = require('syncprompt')
const sleep = require('await-sleep')

const fp = require('../src')
const accounts = require('../shared/accounts')
const db = require('../shared/db')
const helpers = require('../shared/helpers')
const logger = require('../shared/logger')
const paths = require('../shared/paths')
const routes = require('../shared/routes')
const utils = require('../shared/utils')

program
  .option('-w, --website <airline>', 'IATA 2-letter code of the airline whose website to search')
  .option('-p, --partners', `Include partner awards (default: false)`)
  .option('-f, --from <city>', `IATA 3-letter code of the departure airport`)
  .option('-t, --to <city>', `IATA 3-letter code of the arrival airport`)
  .option('-o, --oneway', `Searches for one-way award inventory only (default: search both directions)`)
  .option('-c, --cabin <class>', `Cabin (${Object.keys(fp.cabins).join(', ')})`, (x) => (x in fp.cabins) ? x : false, undefined)
  .option('-s, --start <date>', `Starting date of the search range (YYYY-MM-DD)`, (x) => parseDate(x), undefined)
  .option('-e, --end <date>', `Ending date of the search range (YYYY-MM-DD)`, (x) => parseDate(x), undefined)
  .option('-q, --quantity <n>', `# of passengers traveling`, (x) => parseInt(x), 1)
  .option('-a, --account <n>', `Index of account to use`, (x) => parseInt(x), 0)
  .option('-h, --headless', `Run Chrome in headless mode`)
  .option('-P, --no-parser', `Do not parse search results`)
  .option('-r, --reverse', `Run queries in reverse chronological order`)
  .option('--terminate <n>', `Terminate search if no results are found for n successive days`, (x) => parseInt(x), 0)
  .option('--force', 'Re-run queries, even if already in the database')
  .on('--help', () => {
    console.log('')
    console.log('  Supported Websites:')
    console.log('')
    fp.supported().forEach(id => console.log(`    ${id} - ${fp.new(id).config.name}`))
  })
  .parse(process.argv)

function parseDate (strDate) {
  const dt = DateTime.fromFormat(strDate, 'yyyy-MM-dd')
  return dt.isValid ? dt : false
}

function fatal (message, err) {
  logger.error(message)
  if (err) {
    console.error(err)
  }
  process.exit(1)
}

function populateArguments (args) {
  // Default to one-day search if end date is not specified
  if (args.start && !args.end) {
    args.end = args.start
  }

  // Fill in missing arguments
  if (!args.website) {
    args.website = prompt('Airline website to search (2-letter code)? ')
  }
  if (!args.from) {
    args.from = prompt('Departure city (3-letter code)? ')
  }
  if (!args.to) {
    args.to = prompt('Arrival city (3-letter code)? ')
  }
  if (!args.cabin) {
    args.cabin = prompt(`Desired cabin class (${Object.keys(fp.cabins).join('/')})? `)
  }
  if (!args.start) {
    args.start = parseDate(prompt('Start date of search range (YYYY-MM-DD)? '))
  }
  if (!args.end) {
    args.end = parseDate(prompt('End date of search range (YYYY-MM-DD)? '))
  }
  args.partners = !!args.partners
  args.oneway = !!args.oneway
  args.headless = !!args.headless
  args.parser = !!args.parser
  args.force = !!args.force
}

function validateArguments (args) {
  // Validate arguments
  if (!fp.supported(args.website)) {
    fatal(`Unsupported airline website to search: ${args.website}`)
  }
  if (!(args.cabin in fp.cabins)) {
    fatal(`Unrecognized cabin specified: ${args.cabin}`)
  }
  if (!args.start) {
    fatal(`Invalid start date: ${args.start}`)
  }
  if (!args.end) {
    fatal(`Invalid end date: ${args.end}`)
  }
  if (args.end < args.start) {
    fatal(`Invalid date range: ${args.start.toSQLDate()} - ${args.end.toSQLDate()}`)
  }
  if (args.quantity < 0) {
    fatal(`Invalid quantity: ${args.quantity}`)
  }
  if (args.account < 0) {
    fatal(`Invalid account index: ${args.account}`)
  }
  if (args.terminate < 0) {
    fatal(`Invalid termination setting: ${args.terminate}`)
  }

  // Instantiate engine, and do further validation
  const engine = fp.new(args.website)
  const { id, website } = engine.config

  // Calculate the valid range allowed by the engine
  const { minDays, maxDays } = engine.config.validation
  const [a, b] = engine.validDateRange()

  // Check if our search range is completely outside the valid range
  if (args.end < a || args.start > b) {
    fatal(`${website} (${id}) only supports searching within the range: ${a.toSQLDate()} - ${b.toSQLDate()}`)
  }

  // If only start or end are outside the valid range, we can adjust them
  if (args.start < a) {
    logger.warn(`${website} (${id}) can only search from ${minDays} day(s) from today, adjusting start of search range to: ${a.toSQLDate()}`)
    args.start = a
  }
  if (args.end > b) {
    logger.warn(`${website} (${id}) can only search up to ${maxDays} day(s) from today, adjusting end of search range to: ${b.toSQLDate()}`)
    args.end = b
  }
}

function generateQueries (args, engine, days) {
  const { start: startDate, end: endDate } = args
  const { roundtripOptimized, tripMinDays, oneWaySupported } = engine.config
  const gap = (args.oneway || !roundtripOptimized) ? 0 : Math.min(tripMinDays, days)
  const validEnd = engine.validDateRange()[1]
  const queries = []

  // Compute cities coming from, and to
  const departCities = { fromCity: args.from, toCity: args.to }
  const returnCities = { fromCity: args.to, toCity: args.from }

  // Compute the one-way segments coming back at beginning of search range
  for (let i = 0; i < gap; i++) {
    const date = startDate.plus({ days: i })
    if (oneWaySupported) {
      queries.push({
        ...returnCities,
        departDate: date,
        returnDate: null
      })
    } else if (date.plus({ days: tripMinDays }) < validEnd) {
      queries.push({
        ...returnCities,
        departDate: date,
        returnDate: date.plus({ days: tripMinDays })
      })
    } else {
      queries.push({
        ...departCities,
        departDate: date.minus({ days: tripMinDays }),
        returnDate: date
      })
    }
  }

  // Compute segments in middle of search range
  for (let i = 0; i < days - gap; i++) {
    const date = startDate.plus({ days: i })
    if (roundtripOptimized) {
      queries.push({
        ...departCities,
        departDate: date,
        returnDate: args.oneway ? null : date.plus({ days: gap })
      })
    } else {
      queries.push({...departCities, departDate: date})
      if (!args.oneway) {
        queries.push({...returnCities, departDate: date})
      }
    }
  }

  // Compute the one-way segments going out at end of search range
  for (let i = gap - 1; i >= 0; i--) {
    const date = endDate.minus({ days: i })
    if (oneWaySupported) {
      queries.push({
        ...departCities,
        departDate: date,
        returnDate: null
      })
    } else if (date.plus({ days: tripMinDays }) < validEnd) {
      queries.push({
        ...departCities,
        departDate: date,
        returnDate: date.plus({ days: tripMinDays })
      })
    } else {
      queries.push({
        ...returnCities,
        departDate: date.minus({ days: tripMinDays }),
        returnDate: date
      })
    }
  }

  // Fill in info that's universal for each query
  queries.forEach(q => {
    q.engine = engine.config.id
    q.partners = args.partners
    q.cabin = args.cabin
    q.quantity = args.quantity
    const routePath = routes.path(q)
    q.json = { path: routePath + '.json', gzip: true }
    q.html = { path: routePath + '.html', gzip: true }
    q.screenshot = { path: routePath + '.jpg' }
  })

  return args.reverse ? queries.reverse() : queries
}

async function redundant (query) {
  const { departDate, returnDate } = query

  // Lookup associated routes from database
  const map = await routes.find(query)

  // Get departures
  const departures = map.get(routes.key(query, departDate))
  const departRedundant = redundantSegment(departures, query)
  if (!departRedundant) {
    return false
  }

  // Check returns
  if (returnDate) {
    const returns = map.get(routes.key(query, returnDate, true))
    const returnRedundant = redundantSegment(returns, query)
    if (!returnRedundant) {
      return false
    }
  }

  return true
}

function redundantSegment (routeMap, query) {
  const { quantity } = query
  if (routeMap) {
    if (routeMap.requests.find(x => x.quantity === quantity)) {
      return true // We've already run a request for this segment
    }
    if (routeMap.awards.find(x => x.segments && x.fares === '' && x.quantity <= quantity)) {
      return true // We already know this segment has no availability for an equal or lesser quantity
    }
  }
  return false
}

const main = async (args) => {
  const { start: startDate, end: endDate, headless, parser: parse, terminate } = args

  // Create engine
  const engine = fp.new(args.website)
  let initialized = false

  try {
    // Create data path if necessary
    if (!fs.existsSync(paths.data)) {
      fs.mkdirSync(paths.data)
    }

    // Create database if necessary, and then open
    db.migrate()
    db.open()

    // Generate queries
    const days = endDate.diff(startDate, 'days').days + 1
    const queries = generateQueries(args, engine, days)

    // Execute queries
    let skipped = 0
    let daysRemaining = terminate
    let lastDate = null
    console.log(`Searching ${days} days of award inventory: ${startDate.toSQLDate()} - ${endDate.toSQLDate()}`)
    for (const query of queries) {
      const { id, loginRequired } = engine.config

      // Check if the query's results are already stored
      if (!args.force && await redundant(query)) {
        skipped++
        continue
      }

      // Should we terminate?
      if (terminate && parse && query.departDate !== lastDate) {
        daysRemaining--
        lastDate = query.departDate
        if (daysRemaining < 0) {
          console.log(`Terminating search after no award inventory found for ${terminate} days.`)
        }
      }

      // Lazy load the search engine
      if (!initialized) {
        const credentials = loginRequired
          ? accounts.getCredentials(id, args.account) : null
        await engine.initialize({ credentials, parse, headless })
        initialized = true
      }

      // Print route(s) being searched
      routes.print(query)

      // Run the search query
      let results
      try {
        results = await engine.search(query)
      } catch (err) {
        engine.error('Unexpected error occurred while searching!')
        console.error(err)
        continue
      }

      // Check for an error
      if (results.error) {
        continue
      }

      // Write request and awards (if parsed) to database
      const requestId = helpers.saveRequest(results)
      if (results.awards) {
        if (results.awards.length > 0) {
          daysRemaining = terminate // Reset termination counter
        }
        helpers.addPlaceholders(results, { cabins: Object.values(fp.cabins) })
        helpers.saveAwards(requestId, results.awards)
      }

      // Insert a delay if we've been blocked
      if (results.blocked) {
        const delay = utils.randomInt(65, 320)
        engine.warn(`Blocked by server, waiting for ${humanize(delay * 1000)}`)
        await sleep(delay * 1000)
      }
    }
    if (skipped > 0) {
      console.log(`Skipped ${skipped} queries.`)
    }
    logger.success('Search complete!')
  } catch (err) {
    fatal('A fatal error occurred!', err)
  } finally {
    await engine.close()
    db.close()
  }
}

populateArguments(program)
validateArguments(program)
main(program)
