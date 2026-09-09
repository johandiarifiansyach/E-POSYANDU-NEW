import ReactChildrenTablePage, { type ReactChildrenTablePageProps } from '../features/children/ReactChildrenTablePage';

export type ProblemTidakNaikPageProps = ReactChildrenTablePageProps;

export default function ProblemTidakNaikPage(props: ProblemTidakNaikPageProps) {
  return <ReactChildrenTablePage {...props} initialView="problem_tidak_naik" />;
}
