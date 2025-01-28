import './i18n';
import './error-tracking';

import { h, render, Fragment } from 'preact';
import { useState, useRef, useEffect, useLayoutEffect } from 'preact/hooks';
import { useTranslation, Trans } from 'react-i18next';

import { sortServicesPinned } from './utils/bus';
import fetchCache from './utils/fetchCache';
import setIcon from '../utils/setIcon';

import ArrivalTimeText from './components/ArrivalTimeText';
import LocaleSelector from './components/LocaleSelector';

import wheelchairImagePath from './images/wheelchair.svg';
import wheelchairInaccessibleImagePath from './images/wheelchair-inaccessible.svg';
import busSingleImagePath from './images/bus-single.svg';
import busDoubleImagePath from './images/bus-double.svg';
import busBendyImagePath from './images/bus-bendy.svg';

const dataPath = 'https://data.busrouter.sg/v1/';
const stopsJSONPath = dataPath + 'stops.min.json';

const BUSES = {
  sd: {
    alt: 'Single deck bus',
    src: busSingleImagePath,
    width: 20,
  },
  dd: {
    alt: 'Double deck bus',
    src: busDoubleImagePath,
    width: 20,
  },
  bd: {
    alt: 'Bendy bus',
    src: busBendyImagePath,
    width: 26,
  },
};

const WheelChair = ({ size = 11 }) => (
  <img
    src={wheelchairImagePath}
    width={size}
    height={size}
    alt="Wheelchair accessible"
  />
);

const WheelChairInaccessible = ({ size = 11 }) => (
  <img
    src={wheelchairInaccessibleImagePath}
    width={size}
    height={size}
    alt="Wheelchair inaccessible"
  />
);

const Bus = (props) => {
  const { maxPx, index, duration_ms, type, load, feature, _ghost, _id } = props;

  const busImage = BUSES[type.toLowerCase()];

  const prevPx = useRef();
  const px = (duration_ms / 1000 / 60) * (duration_ms > 0 ? 10 : 2.5);

  const busTooFar = px > maxPx - 30; // 30 = bus width
  const pxFar = 90 + index * 2; // index = zero-based

  useEffect(() => {
    prevPx.current = px;
  }, [px]);

  let time = 1; // 1 second
  if (prevPx.current) {
    const distance = Math.abs(prevPx.current - px);
    time = distance / 10;
  }

  return (
    <span
      id={_id ? `bus-${_id}` : null}
      class={`bus ${_ghost ? 'ghost' : ''}`}
      style={{
        marginLeft: busTooFar ? pxFar + '%' : px.toFixed(1) + 'px',
        transitionDuration: `${time}s`,
      }}
    >
      <span class="bus-float">
        {/* <b class="debug">{_id}</b> */}
        <img {...busImage} />
        <br />
        <span class={`time time-${load.toLowerCase()}`}>
          <ArrivalTimeText ms={duration_ms} />
        </span>
        {feature.toLowerCase() !== 'wab' && <WheelChairInaccessible />}
      </span>
    </span>
  );
};

let BUSID = 1;
const busID = () => BUSID++;
const isSameBus = (b1, b2) =>
  b1.feature === b2.feature &&
  b1.type === b2.type &&
  b1.visit_number === b2.visit_number &&
  b1.origin_code === b2.origin_code &&
  b1.destination_code === b2.destination_code;
const isSameBuses = (b1, b2) =>
  b1.map((b) => b._id).join() === b2.map((b) => b._id).join();

function BusLane({ index, no, buses }) {
  const prevNo = useRef();
  const prevBuses = useRef();
  const nextBuses = buses.filter((nb) => typeof nb?.duration_ms === 'number');

  if (prevNo.current === no && !isSameBuses(prevBuses.current, nextBuses)) {
    nextBuses.forEach((nb) => {
      delete nb._id;
    });

    const pBuses = prevBuses.current.filter((b) => !b._ghost); // Remove previously ghosted buses
    pBuses.forEach((b, i) => {
      // Next bus requirements/checks
      // - Within range of duration_ms of current bus
      // - Not assigned with ID (possibly from previous loop execution)
      // - Same bus type as current bus
      const latestNextBus = nextBuses.find((nb) => {
        if (nb._id || !isSameBus(b, nb)) return false;
        const d = (nb.duration_ms - b.duration_ms) / 1000 / 60;
        return d > -5 && d < 3;
      });
      if (latestNextBus) {
        latestNextBus._id = b._id; // Assign ID for marking
      } else {
        // Insert "ghost" bus that will dissapear into thin air
        b._ghost = true;
        nextBuses.splice(i, 0, b);
      }
    });
  }

  nextBuses.forEach((nb) => {
    if (!nb._id) nb._id = busID();
  });

  // DEBUGGING
  // const prevBusesClone = structuredClone(prevBuses.current);
  // const nextBusesClone = structuredClone(nextBuses);
  // if (no == 315) {
  //   console.log(
  //     no,
  //     prevBusesClone?.map((b) => b._id)?.join(),
  //     nextBusesClone?.map((b) => b._id)?.join(),
  //   );
  // }

  useEffect(() => {
    prevNo.current = no;
    prevBuses.current = structuredClone(nextBuses);
  }, [no, nextBuses]);

  const busLaneRef = useRef();
  const [busLaneWidth, setBusLaneWidth] = useState(0);
  useLayoutEffect(() => {
    setBusLaneWidth(busLaneRef.current?.offsetWidth);
  }, []);

  return (
    <div class="bus-lane" ref={busLaneRef}>
      {nextBuses.map((b, i) => (
        <Bus key={b._id} index={i} {...b} maxPx={busLaneWidth} />
      ))}
      {index && <span class="visit-number">{index}</span>}
    </div>
  );
}

function ArrivalTimes() {
  const { t, i18n } = useTranslation();
  const [busStop, setBusStop] = useState(null);
  const [stopsData, setStopsData] = useState(null);
  const [fetchServicesStatus, setFetchServicesStatus] = useState(null); // 'loading', 'error', 'online'
  const [services, setServices] = useState(null);
  const initialPinnedServices =
    JSON.parse(localStorage.getItem('busroutersg.arrival.pinnedServices')) ||
    [];
  const [pinnedServices, setPinnedServices] = useState(initialPinnedServices);

  useEffect(async () => {
    const stops = await fetchCache(stopsJSONPath, 24 * 60);

    window.onhashchange = () => {
      const code = location.hash.slice(1);
      if (code) {
        const stop = stops[code];
        if (stop) {
          const [lng, lat, name] = stop;
          setBusStop({ code, name, lat, lng });
          setIcon(code);
        } else {
          alert(t('arrivals.invalidBusStopCode'));
        }
      } else {
        setBusStop(null);
      }
    };
    window.onhashchange();
    setStopsData(stops);
  }, []);

  useEffect(() => {
    if (busStop?.code) {
      const { code, name } = busStop;
      document.title = t('arrivals.titleStop', {
        stopNumber: code,
        stopName: name,
      });
      document
        .querySelector('[name="apple-mobile-web-app-title"]')
        .setAttribute('content', document.title);
    } else {
      document.title = t('arrivals.title');
      document
        .querySelector('[name="apple-mobile-web-app-title"]')
        .setAttribute('content', document.title);
    }
  }, [busStop, i18n.resolvedLanguage]);

  let arrivalsTimeout, arrivalsRAF;
  function fetchServices(id) {
    if (!id) return;
    if (window._PAUSED) return;
    setFetchServicesStatus('loading');
    fetch(`https://arrivelah2.busrouter.sg/?id=${id}`)
      .then((r) => r.json())
      .then((results) => {
        setFetchServicesStatus(results.services?.length ? 'online' : null);
        setServices(results.services);
        arrivalsTimeout = setTimeout(() => {
          arrivalsRAF = requestAnimationFrame(() => fetchServices(id));
        }, 15 * 1000); // 15 seconds
      })
      .catch((e) => {
        console.error(e);
        setFetchServicesStatus('error');
        arrivalsTimeout = setTimeout(() => {
          arrivalsRAF = requestAnimationFrame(() => fetchServices(id));
        }, 3 * 1000); // 3 seconds
      });
  }

  useEffect(() => {
    if (busStop) fetchServices(busStop.code);
    return () => {
      clearTimeout(arrivalsTimeout);
      cancelAnimationFrame(arrivalsRAF);
    };
  }, [busStop]);

  function togglePin(no) {
    if (pinnedServices.includes(no)) {
      const index = pinnedServices.indexOf(no);
      pinnedServices.splice(index, 1);
    } else {
      pinnedServices.push(no);
    }
    setPinnedServices([...pinnedServices]);
    try {
      localStorage.setItem(
        'busroutersg.arrival.pinnedServices',
        JSON.stringify(pinnedServices),
      );
    } catch (e) {}
  }

  if (!busStop) {
    if (stopsData) {
      return (
        <ul class="stops-list">
          {Object.keys(stopsData).map((stop) => (
            <li>
              <a href={`#${stop}`}>{stopsData[stop][2]}</a>
            </li>
          ))}
        </ul>
      );
    }
    return;
  }

  const { code, name, lat, lng } = busStop;
  if (services) services.sort(sortServicesPinned(pinnedServices));

  const hasMultipleVisits = services?.some((service) => {
    const { next, next2, next3 } = service;
    return (
      next?.visit_number > 1 ||
      next2?.visit_number > 1 ||
      next3?.visit_number > 1
    );
  });

  return (
    <div>
      <div id="bus-stop-map">
        <img
          src={`https://busroutersg-staticmaps.cheeaun.workers.dev/${lng},${lat},17,0,60/400x200@2x`}
          alt="Bus stop map"
          width="400"
          height="200"
          intrinsicsize="400x200"
          loading="lazy"
        />
      </div>
      <h1>
        {t('arrivals.preHeading')}
        <b id="bus-stop-name">
          <span class={`stop-tag ${fetchServicesStatus}`}>{code}</span> {name}
        </b>
      </h1>
      <table>
        {services ? (
          services.length ? (
            <tbody class={!services.length ? 'loading' : ''}>
              {services.map(({ no, next, next2, next3 }) => {
                const pinned = pinnedServices.includes(no);
                const buses = [next, next2, next3];
                const buses1 = buses.filter((b) => b?.visit_number === 1);
                const buses2 = buses.filter((b) => b?.visit_number === 2);
                return (
                  <>
                    <tr class={pinned ? 'pin' : ''}>
                      <th
                        onClick={(e) => {
                          e.preventDefault();
                          togglePin(no);
                        }}
                      >
                        {no}
                      </th>
                      <td
                        class={`bus-lane-cell ${
                          buses2.length ? 'multiple' : ''
                        }`}
                      >
                        {buses2.length ? (
                          <>
                            <BusLane index={1} no={no} buses={buses1} />
                            <BusLane index={2} no={no} buses={buses2} />
                          </>
                        ) : (
                          <BusLane no={no} buses={buses} />
                        )}
                      </td>
                    </tr>
                    <tr class={pinned ? 'pin' : ''}>
                      <th colspan="2">
                        <small class="destination">
                          {stopsData[next.destination_code][2]}
                        </small>
                      </th>
                    </tr>
                  </>
                );
              })}
            </tbody>
          ) : (
            <tbody>
              <tr>
                <td class="blank">No arrival times available.</td>
              </tr>
            </tbody>
          )
        ) : (
          <tbody class="loading">
            <tr>
              <td>Loading&hellip;</td>
            </tr>
          </tbody>
        )}
      </table>
      <div class="legend">
        <div class="loads">
          <span class="load load-sea">{t('glossary.seatsAvailable')}</span>
          <span class="load load-sda">{t('glossary.standingAvailable')}</span>
          <span class="load load-lsd">{t('glossary.limitedStanding')}</span>
        </div>
        {hasMultipleVisits && (
          <p class="visits">
            <span class="visit-numbers">
              <span class="visit-number">1</span>
              <span class="visit-number">2</span>
            </span>
            {t('arrivals.multipleVisitsLegend')}
          </p>
        )}
      </div>
      <footer>
        <Trans i18nKey="arrivals.wheelchairDisclaimer">
          <WheelChair size="16" /> All public buses in revenue service are
          <a
            href="https://en.wikipedia.org/wiki/Public_buses_of_Singapore#2020s:_In_with_electric_buses,_out_with_non-wheelchair-accessible_buses"
            target="_blank"
          >
            wheelchair-accessible
          </a>
          . The ones that are not accesssible will be marked with this icon
          <WheelChairInaccessible size="16" />.
        </Trans>
        <p>
          <LocaleSelector />
        </p>
      </footer>
    </div>
  );
}

const $arrivals = document.getElementById('arrivals');
render(<ArrivalTimes />, $arrivals);
