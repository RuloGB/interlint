import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** A violation as a FreezingArchRule store holds it when it was frozen from broken classes: `<Order>` has no package. */
export const FROZEN_BROKEN = "Field <com.acme.mapper.OrderMapper.order> has type <Order> in (OrderMapper.java:0)"
/** The same violation as ArchUnit reports it once the classes are sound again. */
export const FROZEN_AGAIN =
  "Field <com.acme.mapper.OrderMapper.order> has type <com.acme.domain.Order> in (OrderMapper.java:14)"
/** A violation the store does not hold. */
export const NEW_VIOLATION =
  "Method <com.acme.web.OrderController.list()> calls method <com.acme.infra.OrderRepository.all()> in (OrderController.java:21)"

/** Writes `archunit_store` in `projectDir`, holding the violations for one rule. */
export function writeStore(projectDir: string, ...violations: string[]) {
  const dir = join(projectDir, "archunit_store")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "stored.rules"), "classes\\ should\\ only\\ depend\\ on\\ domain=5d1b8a2e-rule\n")
  writeFileSync(join(dir, "5d1b8a2e-rule"), violations.join("\n"))
}

/** A Surefire report in which one ArchUnit rule failed with the violations. */
export function surefireReport(...violations: string[]): string {
  const message = [
    `Architecture Violation [Priority: MEDIUM] - Rule 'classes should only depend on domain, because ARCH-07: mappers' was violated (${violations.length} times):`,
    ...violations,
  ]
    .join("&#10;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="ArchitectureRulesTest" tests="1">
<testcase name="MAPPERS" classname="ArchitectureRulesTest">
  <failure message="${message}" type="java.lang.AssertionError"><![CDATA[stack trace]]></failure>
</testcase>
</testsuite>`
}
